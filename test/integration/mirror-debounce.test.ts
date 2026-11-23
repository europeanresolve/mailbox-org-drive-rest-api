import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import { collectionsApp } from "../helpers/collections-app.ts";
import { fetchMirror, readRows, waitUntil } from "../helpers/mirror.ts";

const contactCollection = {
	contact: {
		schema: {
			type: "object",
			additionalProperties: false,
			required: ["email", "name", "age"],
			properties: {
				email: { type: "string", maxLength: 254 },
				name: { type: "string", maxLength: 100 },
				age: { type: "integer" },
			},
		},
		operations: { create: "anonymous", get: "apiKey" },
		rateLimit: { max: 10_000, windowSeconds: 60 },
	},
} as const;

function logWrites(lines: string[], collection: string): number {
	return lines.filter((line) => {
		try {
			const row = JSON.parse(line) as { msg?: string; collection?: string };
			return row.msg === "mirror written" && row.collection === collection;
		} catch {
			return false;
		}
	}).length;
}

function parseLogTime(line: string): number | undefined {
	try {
		const row = JSON.parse(line) as { time?: number };
		return row.time;
	} catch {
		return undefined;
	}
}

async function waitSettled(db: Db, name: string): Promise<void> {
	await waitUntil(
		async () => {
			const s = await db
				.collection<{
					_id: string;
					dirtySeq?: number;
					mirroredSeq?: number;
				}>("mirror_state")
				.findOne({ _id: name });
			return (
				s?.dirtySeq !== undefined &&
				s.mirroredSeq !== undefined &&
				s.mirroredSeq >= s.dirtySeq
			);
		},
		30_000,
		50,
	);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mirror debounce and max wait", () => {
	it("coalesces a burst into at most two uploads", async () => {
		const app = await collectionsApp({
			role: "all",
			mirror: true,
			mirrorTimings: { pollMs: 25, debounceMs: 300, maxWaitMs: 5000 },
			collections: contactCollection,
		});
		try {
			for (let i = 0; i < 20; i++) {
				const res = await app.fetch("/v1/contact", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						email: `u${i}@example.invalid`,
						name: `U${i}`,
						age: 20 + i,
					}),
				});
				expect(res.status).toBe(201);
				if (i < 19) await delay(20);
			}

			await waitSettled(app.db, "contact");
			const writes = logWrites(app.logs.lines(), "contact");
			expect(writes).toBeLessThanOrEqual(2);

			const bytes = await fetchMirror(app.mirrorFolder, "contact.xlsx");
			expect(bytes).not.toBeNull();
			const { rows } = await readRows(bytes as Buffer);
			expect(rows.length - 1).toBe(20);
		} finally {
			await app.close();
		}
	});

	it("mirrors at least once within max wait under steady traffic", async () => {
		const app = await collectionsApp({
			role: "all",
			mirror: true,
			mirrorTimings: { pollMs: 25, debounceMs: 300, maxWaitMs: 800 },
			collections: contactCollection,
		});
		try {
			const writeLines: string[] = [];
			const start = Date.now();
			let i = 0;
			while (Date.now() - start < 2500) {
				const res = await app.fetch("/v1/contact", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						email: `s${i}@example.invalid`,
						name: `S${i}`,
						age: 30,
					}),
				});
				expect(res.status).toBe(201);
				i++;
				await delay(100);
			}
			const lastPostAt = Date.now();

			await waitUntil(
				() => {
					const newLines = app.logs
						.lines()
						.filter((l) => !writeLines.includes(l));
					writeLines.push(...newLines);
					return logWrites(app.logs.lines(), "contact") >= 1;
				},
				10_000,
				50,
			);

			const writtenLines = app.logs.lines().filter((line) => {
				try {
					const row = JSON.parse(line) as { msg?: string };
					return row.msg === "mirror written";
				} catch {
					return false;
				}
			});
			const firstWriteTime = writtenLines
				.map(parseLogTime)
				.find((t) => t !== undefined);
			expect(firstWriteTime).toBeDefined();
			expect(firstWriteTime as number).toBeLessThan(lastPostAt);
		} finally {
			await app.close();
		}
	});

	it("tracks pendingSince until the collection is fully mirrored", async () => {
		const app = await collectionsApp({
			role: "all",
			mirror: true,
			mirrorTimings: { pollMs: 25, debounceMs: 300, maxWaitMs: 5000 },
			collections: contactCollection,
		});
		try {
			const res = await app.fetch("/v1/contact", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: "p@example.invalid",
					name: "P",
					age: 1,
				}),
			});
			expect(res.status).toBe(201);

			await waitUntil(
				async () => {
					const s = await app.db
						.collection<{ _id: string; pendingSince?: Date }>("mirror_state")
						.findOne({ _id: "contact" });
					return s?.pendingSince instanceof Date;
				},
				5000,
				25,
			);

			await waitSettled(app.db, "contact");
			const after = await app.db
				.collection<{ _id: string; pendingSince?: Date }>("mirror_state")
				.findOne({ _id: "contact" });
			expect(after?.pendingSince).toBeUndefined();
		} finally {
			await app.close();
		}
	});
});
