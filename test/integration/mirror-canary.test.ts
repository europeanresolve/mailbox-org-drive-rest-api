import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, inject, it } from "vitest";
import { stringify } from "yaml";
import type { MirrorErrorCode } from "../../src/mirror/state.ts";
import { start } from "../../src/server.ts";
import { collectionsApp, newKey } from "../helpers/collections-app.ts";
import { captureLogs } from "../helpers/log-capture.ts";
import { fetchMirror, putMirrorRaw, waitUntil } from "../helpers/mirror.ts";
import { STACK } from "./global-setup.ts";

const CANARY = "CANARY-3c9e@example.invalid";
const CANARY_PATTERN = /canary-3c9e/i;
const FORMULA_PREFIX = "=CANARY-3c9e";

const opsKey = newKey();

const mirrorTimings = {
	pollMs: 25,
	debounceMs: 100,
	backoffBaseMs: 200,
	backoffMaxMs: 60_000,
};

const canaryCollection = {
	contact: {
		schema: {
			type: "object",
			additionalProperties: false,
			required: ["email", "name", "note"],
			properties: {
				email: { type: "string", maxLength: 254, format: "email" },
				name: { type: "string", maxLength: 100 },
				note: { type: "string", maxLength: 2000 },
			},
		},
		operations: { create: "anonymous", get: "apiKey" },
		rateLimit: { max: 10_000, windowSeconds: 60 },
	},
} as const;

function logHas(
	lines: string[],
	msg: string,
	predicate: (row: Record<string, unknown>) => boolean = () => true,
): boolean {
	return lines.some((line) => {
		try {
			const row = JSON.parse(line) as Record<string, unknown>;
			return row.msg === msg && predicate(row);
		} catch {
			return false;
		}
	});
}

function sweepNoCanary(lines: string[], body: string): void {
	for (const line of lines) expect(line).not.toMatch(CANARY_PATTERN);
	expect(body).not.toMatch(CANARY_PATTERN);
}

async function waitMirrored(
	db: Awaited<ReturnType<typeof collectionsApp>>["db"],
	minDirty: number,
): Promise<void> {
	await waitUntil(
		async () => {
			const s = await db
				.collection<{
					_id: string;
					dirtySeq?: number;
					mirroredSeq?: number;
				}>("mirror_state")
				.findOne({ _id: "contact" });
			return (
				s?.mirroredSeq !== undefined &&
				s?.dirtySeq !== undefined &&
				s.mirroredSeq >= s.dirtySeq &&
				s.dirtySeq >= minDirty
			);
		},
		30_000,
		50,
	);
}

async function waitForceUploadCleared(
	db: Awaited<ReturnType<typeof collectionsApp>>["db"],
	name: string,
): Promise<void> {
	await waitUntil(
		async () => {
			const s = await db
				.collection<{ _id: string; forceUpload?: boolean }>("mirror_state")
				.findOne({ _id: name });
			return s?.forceUpload !== true;
		},
		30_000,
		50,
	);
}

async function bumpDirty(
	db: Awaited<ReturnType<typeof collectionsApp>>["db"],
): Promise<void> {
	await db
		.collection<{ _id: string }>("mirror_state")
		.updateOne(
			{ _id: "contact" },
			{ $inc: { dirtySeq: 1 }, $set: { dueAt: new Date(0) } },
		);
}

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

describe("mirror canary sweep (03-08)", () => {
	const runId = inject("runId");
	const dbName = `it-${runId}-mirror-canary`;
	const logsPhase2 = captureLogs();

	let phase1: Awaited<ReturnType<typeof collectionsApp>>;

	afterAll(async () => {
		await phase1?.close();
	});

	it("keeps record values out of logs and /mirror/status on every path", async () => {
		const longNote = `${"x".repeat(240)}${CANARY}${"y".repeat(240)}`;

		phase1 = await collectionsApp({
			role: "all",
			mirror: true,
			dbName,
			mirrorConfig: { maxCellLength: 100 },
			mirrorTimings,
			collections: canaryCollection,
			keys: [
				{
					name: "ops",
					key: opsKey,
					grants: ["mirror:status", "mirror:rebuild"],
				},
			],
		});

		const create = await phase1.fetch("/v1/contact", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				email: CANARY,
				name: FORMULA_PREFIX,
				note: longNote,
			}),
		});
		expect(create.status).toBe(201);
		await waitMirrored(phase1.db, 1);

		expect(
			logHas(phase1.logs.lines(), "mirror written", (row) => {
				const truncated = row.truncatedCells;
				return typeof truncated === "number" && truncated > 0;
			}),
		).toBe(true);

		await putMirrorRaw(
			phase1.mirrorFolder,
			"contact.xlsx",
			Buffer.from("external edit"),
		);
		await waitUntil(
			async () => {
				const bytes = await fetchMirror(phase1.mirrorFolder, "contact.xlsx");
				return bytes !== null && bytes.length < 64;
			},
			3000,
			50,
		);
		await bumpDirty(phase1.db);
		await waitMirrored(phase1.db, 2);
		expect(
			logHas(phase1.logs.lines(), "mirror replaced an external change"),
		).toBe(true);

		const rebuild = await phase1.fetch("/mirror", {
			method: "POST",
			headers: { authorization: `Bearer ${opsKey}` },
		});
		expect(rebuild.status).toBe(202);
		await waitForceUploadCleared(phase1.db, "contact");

		const statusRes = await phase1.fetch("/mirror/status", {
			headers: { authorization: `Bearer ${opsKey}` },
		});
		const statusBody = await statusRes.text();
		const phase1Lines = phase1.logs.lines();
		sweepNoCanary(phase1Lines, statusBody);

		await phase1.close();
		phase1 = undefined as never;

		const scratch = mkdtempSync(join(tmpdir(), "snook-mirror-canary-fail-"));
		const parent = `/run-${runId}/canary-${dbName}`;
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
			mirror: { mount: "mirror", maxCellLength: 100 },
			collections: canaryCollection,
		};
		const file = join(scratch, "config.yaml");
		writeFileSync(file, stringify(document));
		await ensureParent(`${parent}/live`);

		const service = await start({
			env: { CONFIG_FILE: file, PORT: "0", ROLE: "all" },
			logStream: logsPhase2.stream,
			adapterTimings: { retries: 1, minTimeout: 1, maxTimeout: 5 },
			mirrorTimings,
		});

		const mongo = new MongoClient(mongoUri);
		const db = mongo.db();
		const port = (service.app.server.address() as { port: number }).port;
		const base = `http://127.0.0.1:${port}`;

		try {
			const bump = await fetch(`${base}/v1/contact`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: "bump@example.invalid",
					name: "Bump",
					note: "bump",
				}),
			});
			expect(bump.status).toBe(201);

			await waitUntil(
				async () => {
					const s = await db
						.collection<{
							_id: string;
							failures?: number;
							lastError?: MirrorErrorCode;
						}>("mirror_state")
						.findOne({ _id: "contact" });
					return (s?.failures ?? 0) >= 1 && s?.lastError != null;
				},
				8000,
				50,
			);
			expect(logHas(logsPhase2.lines(), "mirror pass failed")).toBe(true);

			const allLines = [...phase1Lines, ...logsPhase2.lines()];
			sweepNoCanary(allLines, statusBody);
		} finally {
			await service.close();
			await mongo.close().catch(() => undefined);
			rmSync(scratch, { recursive: true, force: true });
		}
	}, 120_000);
});
