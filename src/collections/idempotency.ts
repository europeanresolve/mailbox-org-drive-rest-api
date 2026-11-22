import { createHash, randomUUID } from "node:crypto";
import type { Db } from "mongodb";

/** An entry lives 24 h (D-09); the TTL index removes it, `begin` also ignores it earlier. */
export const ENTRY_TTL_MS = 24 * 3600_000;
/** A pending entry whose lock is older than this is treated as abandoned. */
export const LOCK_TTL_MS = 30_000;

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;
const DUPLICATE_KEY = 11000;

export type StoredResponse = {
	status: number;
	etag: string;
	body: unknown;
};

type Entry = {
	/** sha256 of collection and key: the raw key is never stored or logged. */
	_id: string;
	principal: string;
	bodyHash: string;
	status: "pending" | "complete";
	recordId: string;
	createdAt: Date;
	lockedAt: Date;
	response?: StoredResponse;
};

/** What the create handler does next. */
export type Begin =
	| { kind: "proceed"; recordId: string }
	| { kind: "replay"; response: StoredResponse }
	/** A request with this key is still in flight: 409. */
	| { kind: "in-flight" }
	/** The key was used with another body or by another principal: 422. */
	| { kind: "mismatch" };

/** The key as one header value of 1 to 255 visible ASCII characters, else null. */
export function parseIdempotencyKey(value: unknown): string | null {
	return typeof value === "string" && KEY_PATTERN.test(value) ? value : null;
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [
					key,
					canonical((value as Record<string, unknown>)[key]),
				]),
		);
	}
	return value;
}

/** SHA-256 hex of the JSON form with object keys sorted at every depth; array order counts. */
export function canonicalHash(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}

/** Scope of a key: per collection and key value (D-09). The newline cannot occur in a collection name. */
export function entryId(collection: string, key: string): string {
	return createHash("sha256").update(`${collection}\n${key}`).digest("hex");
}

function isDuplicateKey(error: unknown): boolean {
	return (error as { code?: number } | null)?.code === DUPLICATE_KEY;
}

/**
 * Idempotency entries in the `_idempotency` MongoDB collection. Pessimistic: a pending
 * entry is inserted first, so the unique `_id` decides which concurrent request stores
 * the record. The record id is chosen with that entry, so a request that takes over an
 * abandoned entry stores under the same id and cannot create a second record.
 */
export class IdempotencyStore {
	readonly #db: Db;

	constructor(db: Db) {
		this.#db = db;
	}

	#entries() {
		return this.#db.collection<Entry>("_idempotency");
	}

	async begin(
		collection: string,
		key: string,
		principal: string,
		bodyHash: string,
		now: Date = new Date(),
	): Promise<Begin> {
		const _id = entryId(collection, key);
		// Bounded: each round either wins the insert or sees the entry change under it.
		for (let round = 0; round < 3; round++) {
			const recordId = randomUUID();
			try {
				await this.#entries().insertOne({
					_id,
					principal,
					bodyHash,
					status: "pending",
					recordId,
					createdAt: now,
					lockedAt: now,
				});
				return { kind: "proceed", recordId };
			} catch (error) {
				if (!isDuplicateKey(error)) throw error;
			}

			const existing = await this.#entries().findOne({ _id });
			if (existing === null) continue;

			if (now.getTime() - existing.createdAt.getTime() >= ENTRY_TTL_MS) {
				// Expired but not yet removed by the TTL monitor: treat as absent.
				await this.#entries().deleteOne({ _id, createdAt: existing.createdAt });
				continue;
			}
			if (existing.principal !== principal || existing.bodyHash !== bodyHash) {
				return { kind: "mismatch" };
			}
			if (existing.status === "complete" && existing.response !== undefined) {
				return { kind: "replay", response: existing.response };
			}
			if (now.getTime() - existing.lockedAt.getTime() < LOCK_TTL_MS) {
				return { kind: "in-flight" };
			}
			// One atomic swap of the lock: of several takers, exactly one wins.
			const taken = await this.#entries().findOneAndUpdate(
				{ _id, status: "pending", lockedAt: existing.lockedAt },
				{ $set: { lockedAt: now } },
			);
			return taken === null
				? { kind: "in-flight" }
				: { kind: "proceed", recordId: existing.recordId };
		}
		return { kind: "in-flight" };
	}

	/** Keeps the original response for replays. */
	async complete(
		collection: string,
		key: string,
		response: StoredResponse,
	): Promise<void> {
		await this.#entries().updateOne(
			{ _id: entryId(collection, key), status: "pending" },
			{ $set: { status: "complete", response } },
		);
	}

	/** Frees the key after a failed store, so a retry can proceed. */
	async abandon(collection: string, key: string): Promise<void> {
		await this.#entries().deleteOne({
			_id: entryId(collection, key),
			status: "pending",
		});
	}

	/** Hard delete of a record also removes the response that holds its data (D-13). */
	async removeForRecord(recordId: string): Promise<void> {
		await this.#entries().deleteMany({ recordId });
	}
}
