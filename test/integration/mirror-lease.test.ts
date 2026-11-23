import { type Db, MongoClient } from "mongodb";
import { describe, expect, inject, it } from "vitest";
import { MirrorLease } from "../../src/mirror/lease.ts";
import { MirrorStateStore } from "../../src/mirror/state.ts";
import { resolveTimings } from "../../src/mirror/timings.ts";
import { collectionsApp } from "../helpers/collections-app.ts";
import {
	fetchMirror,
	listMirror,
	readRows,
	waitUntil,
} from "../helpers/mirror.ts";
import { STACK } from "../integration/global-setup.ts";

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

let dbCounter = 0;

function leaseDbName(runId: string, tag: string): string {
	return `it-${runId}-l${tag}${dbCounter++}`;
}

async function withDb<T>(
	dbName: string,
	fn: (db: Db) => Promise<T>,
): Promise<T> {
	const uri = `${STACK.mongoUri}/${dbName}`;
	const client = new MongoClient(uri);
	try {
		await client.connect();
		return await fn(client.db());
	} finally {
		await client
			.db()
			.dropDatabase()
			.catch(() => undefined);
		await client.close().catch(() => undefined);
	}
}

function parseLogRecords(lines: string[]): Array<Record<string, unknown>> {
	return lines
		.map((line) => {
			try {
				return JSON.parse(line) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter((row): row is Record<string, unknown> => row !== null);
}

type PassInterval = { start: number; end: number; token: number };

function passIntervals(lines: string[], collection: string): PassInterval[] {
	const records = parseLogRecords(lines);
	const intervals: PassInterval[] = [];
	let open: { start: number; token: number } | undefined;
	for (const row of records) {
		if (row.collection !== collection) continue;
		const msg = row.msg;
		if (msg === "mirror pass started") {
			open = { start: Number(row.time), token: Number(row.token) };
			continue;
		}
		if (
			open !== undefined &&
			(msg === "mirror written" ||
				msg === "mirror unchanged" ||
				msg === "mirror commit fenced" ||
				msg === "mirror pass failed")
		) {
			intervals.push({
				start: open.start,
				end: Number(row.time),
				token: open.token,
			});
			open = undefined;
		}
	}
	return intervals;
}

describe("mirror lease and fencing", () => {
	it("lease race: exactly one of 20 concurrent acquires succeeds", async () => {
		const runId = inject("runId");
		const dbName = leaseDbName(runId, "r");
		await withDb(dbName, async (db) => {
			const a = new MirrorLease({ db, ttlMs: 5_000 });
			const b = new MirrorLease({ db, ttlMs: 5_000 });
			const results = await Promise.all(
				Array.from({ length: 20 }, (_, i) =>
					(i % 2 === 0 ? a : b).acquire("contact"),
				),
			);
			const won = results.filter((r) => r !== null);
			expect(won).toHaveLength(1);
		});
	});

	it("takeover: expired lease lets another owner acquire with a higher token", async () => {
		const runId = inject("runId");
		const dbName = leaseDbName(runId, "t");
		await withDb(dbName, async (db) => {
			const a = new MirrorLease({ db, ttlMs: 200 });
			const b = new MirrorLease({ db, ttlMs: 200 });
			const first = await a.acquire("contact");
			expect(first).not.toBeNull();
			await new Promise((resolve) => setTimeout(resolve, 300));
			const second = await b.acquire("contact");
			expect(second).not.toBeNull();
			expect(second?.token).toBe((first?.token ?? 0) + 1);
			expect(await a.heartbeat("contact", first?.token ?? 0)).toBe(false);
		});
	});

	it("release: next owner acquires immediately with token + 1", async () => {
		const runId = inject("runId");
		const dbName = leaseDbName(runId, "e");
		await withDb(dbName, async (db) => {
			const a = new MirrorLease({ db, ttlMs: 5_000 });
			const b = new MirrorLease({ db, ttlMs: 5_000 });
			const first = await a.acquire("contact");
			expect(first).not.toBeNull();
			await a.release("contact", first?.token ?? 0);
			const second = await b.acquire("contact");
			expect(second).not.toBeNull();
			expect(second?.token).toBe((first?.token ?? 0) + 1);
		});
	});

	it("fencing: stale token commit is rejected", async () => {
		const runId = inject("runId");
		const dbName = leaseDbName(runId, "f");
		await withDb(dbName, async (db) => {
			const timings = resolveTimings({
				mount: "live",
				debounceSeconds: 1,
				maxWaitSeconds: 60,
				reconcileMinutes: 60,
				maxCellLength: 32_767,
			});
			const state = new MirrorStateStore(db, timings);
			const a = new MirrorLease({ db, ttlMs: 200 });
			const b = new MirrorLease({ db, ttlMs: 200 });
			const old = await a.acquire("contact");
			expect(old).not.toBeNull();
			await new Promise((resolve) => setTimeout(resolve, 300));
			const newer = await b.acquire("contact");
			expect(newer).not.toBeNull();
			await state.fence("contact", newer?.token ?? 0);
			const before = await db
				.collection<{
					_id: string;
					mirroredSeq?: number;
					contentHash?: string;
					lastWrittenEtag?: string | null;
				}>("mirror_state")
				.findOne({ _id: "contact" });
			const stale = await state.commit("contact", old?.token ?? 0, {
				seq: 1,
				contentHash: "a".repeat(64),
				lastWrittenEtag: "etag-a",
			});
			expect(stale).toBe(false);
			const afterStale = await db
				.collection<{
					_id: string;
					mirroredSeq?: number;
					contentHash?: string;
					lastWrittenEtag?: string | null;
				}>("mirror_state")
				.findOne({ _id: "contact" });
			expect(afterStale?.mirroredSeq ?? 0).toBe(before?.mirroredSeq ?? 0);
			expect(afterStale?.contentHash).toBe(before?.contentHash);
			expect(afterStale?.lastWrittenEtag).toBe(before?.lastWrittenEtag);

			const ok = await state.commit("contact", newer?.token ?? 0, {
				seq: 2,
				contentHash: "b".repeat(64),
				lastWrittenEtag: "etag-b",
			});
			expect(ok).toBe(true);
		});
	});

	it("two instances never overlap mirror passes for one collection", async () => {
		const runId = inject("runId");
		const dbName = leaseDbName(runId, "2");
		const mirrorTimings = { pollMs: 25, debounceMs: 50, leaseTtlMs: 2_000 };
		const appA = await collectionsApp({
			role: "all",
			mirror: true,
			dbName,
			collections: contactCollection,
			server: { logLevel: "debug" },
			mirrorTimings,
		});
		const appB = await collectionsApp({
			role: "worker",
			mirror: true,
			dbName,
			collections: contactCollection,
			server: { logLevel: "debug" },
			mirrorTimings,
		});
		try {
			for (let i = 0; i < 10; i++) {
				const res = await appA.fetch("/v1/contact", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						email: `u${i}@example.invalid`,
						name: `User ${i}`,
						age: 20 + i,
					}),
				});
				expect(res.status).toBe(201);
				await waitUntil(
					async () => {
						const s = await appA.db
							.collection<{
								_id: string;
								dirtySeq?: number;
								mirroredSeq?: number;
							}>("mirror_state")
							.findOne({ _id: "contact" });
						return (
							s?.mirroredSeq !== undefined &&
							s.dirtySeq !== undefined &&
							s.mirroredSeq >= s.dirtySeq &&
							s.dirtySeq >= i + 1
						);
					},
					15_000,
					25,
				);
			}

			const folder = appA.mirrorFolder;
			const bytes = await fetchMirror(folder, "contact.xlsx");
			expect(bytes).not.toBeNull();
			const { rows } = await readRows(bytes as Buffer);
			expect(rows.length).toBe(11);

			const names = await listMirror(folder);
			expect(names).toEqual(["contact.xlsx"]);

			const intervals = [
				...passIntervals(appA.logs.lines(), "contact"),
				...passIntervals(appB.logs.lines(), "contact"),
			].sort((a, b) => a.start - b.start);
			expect(intervals.length).toBeGreaterThanOrEqual(10);
			for (let i = 1; i < intervals.length; i++) {
				const prev = intervals[i - 1];
				const next = intervals[i];
				expect(prev?.end).toBeLessThanOrEqual(next?.start ?? 0);
				expect(next?.token).toBeGreaterThan(prev?.token ?? 0);
			}
		} finally {
			await Promise.all([appA.close(), appB.close()]);
		}
	});
});
