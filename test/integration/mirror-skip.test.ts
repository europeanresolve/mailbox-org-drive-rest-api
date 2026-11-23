import type { Db } from "mongodb";
import { describe, expect, it } from "vitest";
import { collectionsApp } from "../helpers/collections-app.ts";
import {
	deleteMirror,
	fetchMirror,
	listMirror,
	mirrorEtag,
	putMirrorRaw,
	readRows,
	waitUntil,
} from "../helpers/mirror.ts";

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

const mirrorTimings = { pollMs: 50, debounceMs: 100, leaseTtlMs: 5_000 };

async function bumpDirty(db: Db): Promise<void> {
	await db
		.collection("mirror_state")
		.updateOne(
			{ _id: "contact" },
			{ $inc: { dirtySeq: 1 }, $set: { dueAt: new Date(0) } },
		);
}

async function waitMirrored(db: Db, minDirty: number): Promise<void> {
	await waitUntil(
		async () => {
			const s = await db
				.collection<{ dirtySeq?: number; mirroredSeq?: number }>("mirror_state")
				.findOne({ _id: "contact" });
			return (
				s?.mirroredSeq !== undefined &&
				s.dirtySeq !== undefined &&
				s.mirroredSeq >= s.dirtySeq &&
				s.dirtySeq >= minDirty
			);
		},
		10_000,
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

describe("mirror content-hash skip and external overwrite", () => {
	it("skips PUT when hash and ETag are unchanged", async () => {
		const app = await collectionsApp({
			role: "all",
			mirror: true,
			mirrorTimings,
			collections: contactCollection,
		});
		try {
			const res = await app.fetch("/v1/contact", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: "skip@example.invalid",
					name: "Skip",
					age: 30,
				}),
			});
			expect(res.status).toBe(201);
			const folder = app.mirrorFolder;
			await waitMirrored(app.db, 1);
			const etag1 = await mirrorEtag(folder, "contact.xlsx");
			expect(etag1).toBeTruthy();
			const before = await app.db
				.collection<{ lastMirroredAt?: Date }>("mirror_state")
				.findOne({ _id: "contact" });

			await bumpDirty(app.db);
			await waitMirrored(app.db, 2);
			const etag2 = await mirrorEtag(folder, "contact.xlsx");
			expect(etag2).toBe(etag1);
			expect(logHas(app.logs.lines(), "mirror unchanged", "contact")).toBe(
				true,
			);

			const after = await app.db
				.collection<{ lastMirroredAt?: Date }>("mirror_state")
				.findOne({ _id: "contact" });
			expect(after?.lastMirroredAt?.getTime() ?? 0).toBeGreaterThan(
				before?.lastMirroredAt?.getTime() ?? 0,
			);
			expect(await listMirror(folder)).toEqual(["contact.xlsx"]);
		} finally {
			await app.close();
		}
	});

	it("overwrites external file edits and records external change", async () => {
		const app = await collectionsApp({
			role: "all",
			mirror: true,
			mirrorTimings,
			collections: contactCollection,
		});
		try {
			const res = await app.fetch("/v1/contact", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: "ext@example.invalid",
					name: "Ext",
					age: 31,
				}),
			});
			expect(res.status).toBe(201);
			const folder = app.mirrorFolder;
			await waitMirrored(app.db, 1);
			await putMirrorRaw(folder, "contact.xlsx", Buffer.from("staff edit"));
			await bumpDirty(app.db);
			await waitMirrored(app.db, 2);

			const bytes = await fetchMirror(folder, "contact.xlsx");
			expect(bytes).not.toBeNull();
			const { rows } = await readRows(bytes as Buffer);
			expect(rows[1]?.[1]).toBe("ext@example.invalid");

			const state = await app.db
				.collection<{
					externalChangeAt?: Date;
					externalChanges?: number;
				}>("mirror_state")
				.findOne({ _id: "contact" });
			expect(state?.externalChangeAt).toBeInstanceOf(Date);
			expect(state?.externalChanges).toBe(1);

			const logText = app.logs.lines().join("\n");
			expect(logText).toContain("mirror replaced an external change");
			expect(logText).toContain('"collection":"contact"');
			expect(logText).not.toContain(folder);
			expect(await listMirror(folder)).toEqual(["contact.xlsx"]);
		} finally {
			await app.close();
		}
	});

	it("recreates a deleted mirror file from MongoDB", async () => {
		const app = await collectionsApp({
			role: "all",
			mirror: true,
			mirrorTimings,
			collections: contactCollection,
		});
		try {
			const res = await app.fetch("/v1/contact", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: "del@example.invalid",
					name: "Del",
					age: 32,
				}),
			});
			expect(res.status).toBe(201);
			const folder = app.mirrorFolder;
			await waitMirrored(app.db, 1);
			await deleteMirror(folder, "contact.xlsx");
			await bumpDirty(app.db);
			await waitMirrored(app.db, 2);

			const bytes = await fetchMirror(folder, "contact.xlsx");
			expect(bytes).not.toBeNull();
			await readRows(bytes as Buffer);
			expect(await listMirror(folder)).toEqual(["contact.xlsx"]);
		} finally {
			await app.close();
		}
	});

	it("replaces a pre-existing non-workbook file on first pass", async () => {
		const app = await collectionsApp({
			role: "all",
			mirror: true,
			mirrorTimings,
			collections: contactCollection,
		});
		try {
			const folder = app.mirrorFolder;
			await putMirrorRaw(folder, "contact.xlsx", Buffer.from("pre-existing"));

			const res = await app.fetch("/v1/contact", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: "pre@example.invalid",
					name: "Pre",
					age: 33,
				}),
			});
			expect(res.status).toBe(201);
			await waitMirrored(app.db, 1);

			const bytes = await fetchMirror(folder, "contact.xlsx");
			expect(bytes).not.toBeNull();
			const { rows } = await readRows(bytes as Buffer);
			expect(rows[1]?.[1]).toBe("pre@example.invalid");

			const state = await app.db
				.collection<{ externalChangeAt?: Date }>("mirror_state")
				.findOne({ _id: "contact" });
			expect(state?.externalChangeAt).toBeInstanceOf(Date);
			expect(await listMirror(folder)).toEqual(["contact.xlsx"]);
		} finally {
			await app.close();
		}
	});
});
