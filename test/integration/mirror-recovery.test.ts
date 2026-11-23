import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { describe, expect, inject, it } from "vitest";
import { stringify } from "yaml";
import type { MirrorErrorCode } from "../../src/mirror/state.ts";
import { start } from "../../src/server.ts";
import { collectionsApp } from "../helpers/collections-app.ts";
import { captureLogs } from "../helpers/log-capture.ts";
import {
	fetchMirror,
	mirrorEtag,
	putMirrorRaw,
	readRows,
	waitUntil,
} from "../helpers/mirror.ts";
import { STACK } from "./global-setup.ts";

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

const ERROR_CODES: MirrorErrorCode[] = [
	"not-found",
	"conflict",
	"forbidden",
	"unauthorized",
	"rate-limited",
	"unavailable",
	"too-large",
	"insufficient-storage",
	"read-only-mount",
	"invalid-path",
	"workbook",
	"internal",
];

function webdavAuth(): string {
	const raw = `${STACK.webdavUser}:${STACK.webdavPassword}`;
	return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function ensureParent(path: string): Promise<void> {
	const res = await fetch(new URL(`.${path}/`, STACK.webdavUrl), {
		method: "MKCOL",
		headers: { Authorization: webdavAuth() },
	});
	if (![201, 405].includes(res.status)) {
		throw new Error(`MKCOL failed with status ${res.status}`);
	}
}

function logMsg(lines: string[], msg: string): number {
	return lines.filter((line) => {
		try {
			return (JSON.parse(line) as { msg?: string }).msg === msg;
		} catch {
			return false;
		}
	}).length;
}

function assertNoSecrets(lines: string[], secret: string): void {
	for (const line of lines) {
		expect(line).not.toContain(secret);
	}
}

describe("mirror reconcile and failure recovery", () => {
	it("reconciles missed records on worker boot", async () => {
		const runId = inject("runId");
		const dbName = `it-${runId}-boot-reconcile`;
		const mongoUri = `${STACK.mongoUri}/${dbName}`;
		const client = new MongoClient(mongoUri);
		const db = client.db();
		const now = new Date();
		await db
			.collection<Record<string, unknown> & { _id: string }>("records_contact")
			.insertMany([
				{
					_id: "r1",
					_v: 1,
					createdAt: now,
					updatedAt: now,
					data: { email: "a@example.invalid", name: "A", age: 1 },
				},
				{
					_id: "r2",
					_v: 1,
					createdAt: now,
					updatedAt: now,
					data: { email: "b@example.invalid", name: "B", age: 2 },
				},
			]);
		await db
			.collection<Record<string, unknown> & { _id: string }>("mirror_state")
			.insertOne({
				_id: "contact",
				dirtySeq: 0,
				mirroredSeq: 0,
				dueAt: now,
			});
		await client.close();

		const app = await collectionsApp({
			dbName,
			role: "all",
			mirror: true,
			mirrorTimings: { pollMs: 50, debounceMs: 200 },
			collections: contactCollection,
		});
		try {
			await waitUntil(
				async () => {
					const bytes = await fetchMirror(app.mirrorFolder, "contact.xlsx");
					if (bytes === null) return false;
					const { rows } = await readRows(bytes);
					return rows.length - 1 === 2;
				},
				5000,
				50,
			);
			const bytes = await fetchMirror(app.mirrorFolder, "contact.xlsx");
			const { rows } = await readRows(bytes as Buffer);
			expect(rows[1]?.[1]).toBe("a@example.invalid");
			expect(rows[2]?.[1]).toBe("b@example.invalid");
		} finally {
			await app.close();
		}
	});

	it("periodically reconciles inserts behind the API", async () => {
		const app = await collectionsApp({
			role: "all",
			mirror: true,
			mirrorTimings: { pollMs: 50, debounceMs: 100, reconcileMs: 500 },
			collections: contactCollection,
		});
		try {
			for (const [email, name] of [
				["one@example.invalid", "One"],
				["two@example.invalid", "Two"],
			] as const) {
				const res = await app.fetch("/v1/contact", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ email, name, age: 1 }),
				});
				expect(res.status).toBe(201);
			}
			await waitUntil(
				async () => {
					const bytes = await fetchMirror(app.mirrorFolder, "contact.xlsx");
					if (bytes === null) return false;
					return (await readRows(bytes)).rows.length - 1 >= 2;
				},
				8000,
				50,
			);

			const now = new Date();
			await app.db
				.collection<Record<string, unknown> & { _id: string }>(
					"records_contact",
				)
				.insertOne({
					_id: `r-${randomBytes(4).toString("hex")}`,
					_v: 1,
					createdAt: now,
					updatedAt: now,
					data: { email: "three@example.invalid", name: "Three", age: 3 },
				});

			await waitUntil(
				async () => {
					const bytes = await fetchMirror(app.mirrorFolder, "contact.xlsx");
					if (bytes === null) return false;
					return (await readRows(bytes)).rows.length - 1 === 3;
				},
				4000,
				50,
			);
		} finally {
			await app.close();
		}
	});

	it("logs unchanged and keeps etag when reconcile finds no drift", async () => {
		const app = await collectionsApp({
			role: "all",
			mirror: true,
			mirrorTimings: { pollMs: 50, debounceMs: 100, reconcileMs: 400 },
			collections: contactCollection,
		});
		try {
			const res = await app.fetch("/v1/contact", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: "same@example.invalid",
					name: "Same",
					age: 5,
				}),
			});
			expect(res.status).toBe(201);
			await waitUntil(
				async () => {
					const s = await app.db
						.collection<{
							_id: string;
							dirtySeq?: number;
							mirroredSeq?: number;
							contentHash?: string;
						}>("mirror_state")
						.findOne({ _id: "contact" });
					const bytes = await fetchMirror(app.mirrorFolder, "contact.xlsx");
					return (
						bytes !== null &&
						s?.contentHash !== undefined &&
						s.dirtySeq !== undefined &&
						s.mirroredSeq !== undefined &&
						s.mirroredSeq >= s.dirtySeq
					);
				},
				8000,
				50,
			);
			const etagBefore = await mirrorEtag(app.mirrorFolder, "contact.xlsx");
			expect(etagBefore).toBeTruthy();
			const unchangedBefore = logMsg(app.logs.lines(), "mirror unchanged");

			await waitUntil(
				() => logMsg(app.logs.lines(), "mirror unchanged") > unchangedBefore,
				5000,
				50,
			);

			const etagAfter = await mirrorEtag(app.mirrorFolder, "contact.xlsx");
			expect(etagAfter).toBe(etagBefore);
		} finally {
			await app.close();
		}
	});

	it("backs off on Drive failure then recovers", async () => {
		const runId = inject("runId");
		const scratch = mkdtempSync(join(tmpdir(), "snook-recovery-"));
		const dbName = `it-${runId}-mirror-backoff`;
		const parent = `/run-${runId}/bk-${dbName}`;
		const blockerRel = "blocker";
		const mirrorMount = `${parent}/${blockerRel}`;
		await ensureParent(parent);
		await putMirrorRaw(parent, blockerRel, Buffer.from("blocked"));

		const mongoUri = `${STACK.mongoUri}/${dbName}`;
		const document = {
			mongo: { uri: mongoUri },
			storage: {
				webdav: {
					url: STACK.webdavUrl,
					username: STACK.webdavUser,
					password: STACK.webdavPassword,
				},
			},
			mounts: {
				live: { path: `${parent}/live`, mode: "read-write" },
				mirror: { path: mirrorMount, mode: "read-write" },
			},
			mirror: { mount: "mirror" },
			collections: contactCollection,
		};
		const file = join(scratch, "config.yaml");
		writeFileSync(file, stringify(document));
		await ensureParent(`${parent}/live`);

		const logs = captureLogs();
		const service = await start({
			env: { CONFIG_FILE: file, PORT: "0", ROLE: "all" },
			logStream: logs.stream,
			adapterTimings: { retries: 1, minTimeout: 1, maxTimeout: 5 },
			mirrorTimings: {
				pollMs: 50,
				debounceMs: 100,
				backoffBaseMs: 200,
				backoffMaxMs: 60_000,
			},
		});

		const mongo = new MongoClient(mongoUri);
		const db = mongo.db();
		try {
			const res = await fetch(
				`http://127.0.0.1:${(service.app.server.address() as { port: number }).port}/v1/contact`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						email: "fail@example.invalid",
						name: "Fail",
						age: 9,
					}),
				},
			);
			expect(res.status).toBe(201);

			await waitUntil(
				async () => {
					const s = await db
						.collection<{
							_id: string;
							failures?: number;
							lastError?: MirrorErrorCode;
							nextAttemptAt?: Date;
						}>("mirror_state")
						.findOne({ _id: "contact" });
					return (
						(s?.failures ?? 0) >= 1 &&
						s?.lastError !== undefined &&
						s.lastError !== null &&
						ERROR_CODES.includes(s.lastError) &&
						s.nextAttemptAt instanceof Date &&
						s.nextAttemptAt.getTime() > Date.now()
					);
				},
				8000,
				50,
			);

			const failedLogs = logMsg(logs.lines(), "mirror pass failed");
			expect(failedLogs).toBe(1);
			assertNoSecrets(logs.lines(), "fail@example.invalid");
			assertNoSecrets(logs.lines(), mirrorMount);

			await waitUntil(
				async () => {
					const s = await db
						.collection<{ _id: string; nextAttemptAt?: Date }>("mirror_state")
						.findOne({ _id: "contact" });
					return (
						s?.nextAttemptAt !== undefined &&
						s.nextAttemptAt.getTime() > Date.now()
					);
				},
				3000,
				50,
			);
			expect(logMsg(logs.lines(), "mirror pass failed")).toBe(1);

			await fetch(new URL(`.${mirrorMount}`, STACK.webdavUrl).toString(), {
				method: "DELETE",
				headers: { Authorization: webdavAuth() },
			});
			await ensureParent(mirrorMount);

			await waitUntil(
				async () => {
					const s = await db
						.collection<{
							_id: string;
							failures?: number;
							lastError?: MirrorErrorCode | null;
						}>("mirror_state")
						.findOne({ _id: "contact" });
					return (s?.failures ?? 1) === 0 && s?.lastError === null;
				},
				15_000,
				100,
			);
			assertNoSecrets(logs.lines(), "fail@example.invalid");
		} finally {
			await service.close();
			await db.dropDatabase().catch(() => undefined);
			await mongo.close().catch(() => undefined);
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
