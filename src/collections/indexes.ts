import type { Db } from "mongodb";
import type { Config } from "../config/schema.ts";

/**
 * One compound index `{ data.<path>: 1, _id: 1 }` per indexed field, plus
 * `{ createdAt: 1, _id: 1 }` and `{ updatedAt: 1, _id: 1 }` (D-19). The `_id` tail is the
 * keyset tie-breaker. createIndexes is idempotent, so a restart is safe; indexes for
 * fields removed from the config stay in place.
 */
export async function ensureIndexes(db: Db, config: Config): Promise<void> {
	for (const [name, definition] of Object.entries(config.collections)) {
		await db.collection(`records_${name}`).createIndexes([
			...(definition.indexes ?? []).map((path) => ({
				key: { [`data.${path}`]: 1, _id: 1 },
				name: `idx_${path.replaceAll(".", "_")}`,
			})),
			{ key: { createdAt: 1, _id: 1 }, name: "idx_createdAt" },
			{ key: { updatedAt: 1, _id: 1 }, name: "idx_updatedAt" },
		]);
	}
	await db.collection("_idempotency").createIndexes([
		// Entries expire 24 h after creation (D-09); createdAt must be a BSON Date.
		{
			key: { createdAt: 1 },
			name: "idx_ttl",
			expireAfterSeconds: 86400,
		},
		// Deleting a record finds its entry by record id (D-13).
		{ key: { recordId: 1 }, name: "idx_recordId" },
	]);
}

/**
 * Runs `ensure` now and again every `retryMs` after a failure, until one run succeeds or
 * `stop()` is called. A MongoDB outage at boot therefore only delays the indexes. The
 * error goes to the logger as `err`, whose serializer keeps type and code and drops the message.
 */
export function scheduleIndexSetup(options: {
	ensure: () => Promise<void>;
	log: { warn: (fields: object, message: string) => void };
	retryMs: number;
}): { stop(): void } {
	let stopped = false;
	let timer: NodeJS.Timeout | undefined;

	const attempt = async (): Promise<void> => {
		try {
			await options.ensure();
		} catch (error) {
			// close() during a failing attempt is not worth a log line.
			if (stopped) return;
			options.log.warn({ err: error }, "index setup failed");
			timer = setTimeout(() => void attempt(), options.retryMs);
			timer.unref();
		}
	};
	void attempt();

	return {
		stop() {
			stopped = true;
			clearTimeout(timer);
		},
	};
}
