import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import { PROBLEM_JSON } from "../../src/http/logging.ts";
import { collectionsApp, newKey } from "../helpers/collections-app.ts";
import { mirrorEtag, waitUntil } from "../helpers/mirror.ts";

const SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["email", "name"],
	properties: {
		email: { type: "string", maxLength: 254, format: "email" },
		name: { type: "string", maxLength: 100 },
	},
} as const;

const CANARY_EMAIL = "canary-7f3a9e2b@example.invalid";

const opsReadKey = newKey();
const opsAllKey = newKey();
const writerKey = newKey();

const STATUS_FIELDS = [
	"name",
	"lastMirroredAt",
	"lagSeconds",
	"pendingWrites",
	"failures",
	"lastError",
	"nextAttemptAt",
	"externalChangeAt",
	"externalChanges",
] as const;

async function waitMirrored(db: Db, name: string): Promise<void> {
	await waitUntil(
		async () => {
			const s = await db
				.collection<{
					_id: string;
					dirtySeq?: number;
					mirroredSeq?: number;
					lastMirroredAt?: Date;
				}>("mirror_state")
				.findOne({ _id: name });
			return (
				s?.lastMirroredAt !== undefined &&
				s.dirtySeq !== undefined &&
				s.mirroredSeq !== undefined &&
				s.mirroredSeq >= s.dirtySeq
			);
		},
		30_000,
		50,
	);
}

function logHas(lines: string[], msg: string, collection: string): boolean {
	return lines.some((line) => {
		try {
			const row = JSON.parse(line) as { msg?: string; collection?: string };
			return row.msg === msg && row.collection === collection;
		} catch {
			return false;
		}
	});
}

function logWriteCount(lines: string[], collection: string): number {
	return lines.filter((line) => {
		try {
			const row = JSON.parse(line) as { msg?: string; collection?: string };
			return row.msg === "mirror written" && row.collection === collection;
		} catch {
			return false;
		}
	}).length;
}

async function waitForceUploadCleared(db: Db, name: string): Promise<void> {
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

describe("mirror operator routes (03-07)", () => {
	it("enforces grants, exposes status, and forces rebuild", async () => {
		const app = await collectionsApp({
			role: "all",
			mirror: true,
			mirrorTimings: { pollMs: 25, debounceMs: 100 },
			collections: {
				contact: {
					schema: SCHEMA,
					operations: { create: "anonymous", get: "apiKey" },
					rateLimit: { max: 10_000, windowSeconds: 60 },
				},
				"events/2026/signups": {
					schema: SCHEMA,
					operations: { create: "anonymous", get: "apiKey" },
					rateLimit: { max: 10_000, windowSeconds: 60 },
				},
			},
			keys: [
				{ name: "ops-read", key: opsReadKey, grants: ["mirror:status"] },
				{
					name: "ops-all",
					key: opsAllKey,
					grants: ["mirror:status", "mirror:rebuild"],
				},
				{ name: "writer", key: writerKey, grants: ["contact:get"] },
			],
		});
		try {
			const unauth = await app.fetch("/mirror/status");
			expect(unauth.status).toBe(401);
			expect(unauth.headers.get("www-authenticate")).toBe("Bearer");
			expect(unauth.headers.get("content-type")).toContain(PROBLEM_JSON);

			const forbidden = await app.fetch("/mirror/status", {
				headers: { authorization: `Bearer ${writerKey}` },
			});
			expect(forbidden.status).toBe(403);

			const statusRes = await app.fetch("/mirror/status", {
				headers: { authorization: `Bearer ${opsReadKey}` },
			});
			expect(statusRes.status).toBe(200);
			expect(statusRes.headers.get("cache-control")).toBe("no-store");
			const statusBody = (await statusRes.json()) as {
				collections: Record<string, unknown>[];
			};
			expect(statusBody.collections.map((c) => c.name)).toEqual([
				"contact",
				"events/2026/signups",
			]);
			for (const entry of statusBody.collections) {
				expect(Object.keys(entry).sort()).toEqual([...STATUS_FIELDS].sort());
				expect(entry.lastMirroredAt).toBeNull();
				expect(entry.pendingWrites).toBe(0);
			}

			const create = await app.fetch("/v1/contact", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email: CANARY_EMAIL, name: "Canary" }),
			});
			expect(create.status).toBe(201);
			await waitMirrored(app.db, "contact");

			const afterWrite = await app.fetch("/mirror/status", {
				headers: { authorization: `Bearer ${opsReadKey}` },
			});
			const afterBody = (await afterWrite.json()) as {
				collections: {
					name: string;
					lastMirroredAt: string | null;
					pendingWrites: number;
				}[];
			};
			const contact = afterBody.collections.find((c) => c.name === "contact");
			expect(contact?.lastMirroredAt).not.toBeNull();
			expect(contact?.pendingWrites).toBe(0);

			const bodyText = JSON.stringify(afterBody);
			expect(bodyText).not.toContain(CANARY_EMAIL);
			expect(bodyText).not.toContain(app.mirrorFolder);

			const etagBefore = await mirrorEtag(app.mirrorFolder, "contact.xlsx");
			expect(etagBefore).not.toBeNull();
			const writesBeforeRebuild = logWriteCount(app.logs.lines(), "contact");

			const rebuildForbidden = await app.fetch("/mirror", {
				method: "POST",
				headers: { authorization: `Bearer ${opsReadKey}` },
			});
			expect(rebuildForbidden.status).toBe(403);

			const rebuildAll = await app.fetch("/mirror", {
				method: "POST",
				headers: { authorization: `Bearer ${opsAllKey}` },
			});
			expect(rebuildAll.status).toBe(202);
			const accepted = (await rebuildAll.json()) as {
				status: string;
				collections: string[];
			};
			expect(accepted).toEqual({
				status: "accepted",
				collections: ["contact", "events/2026/signups"],
			});

			await waitForceUploadCleared(app.db, "contact");
			await waitUntil(
				() => logWriteCount(app.logs.lines(), "contact") > writesBeforeRebuild,
				30_000,
				50,
			);
			const etagAfter = await mirrorEtag(app.mirrorFolder, "contact.xlsx");
			expect(etagAfter).not.toBe(etagBefore);
			expect(logWriteCount(app.logs.lines(), "contact")).toBeGreaterThan(
				writesBeforeRebuild,
			);
			expect(logHas(app.logs.lines(), "mirror unchanged", "contact")).toBe(
				false,
			);
			expect(JSON.stringify(afterBody)).not.toContain(String(etagAfter));

			const one = await app.fetch(
				"/mirror?collection=events%2F2026%2Fsignups",
				{
					method: "POST",
					headers: { authorization: `Bearer ${opsAllKey}` },
				},
			);
			expect(one.status).toBe(202);
			expect(await one.json()).toEqual({
				status: "accepted",
				collections: ["events/2026/signups"],
			});

			const unknown = await app.fetch("/mirror?collection=nope", {
				method: "POST",
				headers: { authorization: `Bearer ${opsAllKey}` },
			});
			expect(unknown.status).toBe(404);
			const unknownText = await unknown.text();
			expect(unknownText).not.toContain("nope");
		} finally {
			await app.close();
		}
	});
});
