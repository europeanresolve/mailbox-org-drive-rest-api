import { describe, expect, it } from "vitest";
import { collectionsApp, newKey } from "../helpers/collections-app.ts";
import {
	fetchMirror,
	listMirror,
	readRows,
	waitUntil,
} from "../helpers/mirror.ts";

const key = newKey();

describe("tracer: record write to mirror xlsx through start()", () => {
	it("mirrors a flat collection after create", async () => {
		const app = await collectionsApp({
			role: "all",
			mirror: true,
			mirrorTimings: { pollMs: 50, debounceMs: 200 },
			collections: {
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
			},
			keys: [{ name: "backend", key, grants: ["contact:get"] }],
		});
		try {
			const res = await app.fetch("/v1/contact", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: "a@example.invalid",
					name: "A",
					age: 41,
				}),
			});
			expect(res.status).toBe(201);

			const state = await app.db
				.collection<{ _id: string; dirtySeq?: number }>("mirror_state")
				.findOne({ _id: "contact" });
			expect(state?.dirtySeq).toBe(1);

			const folder = app.mirrorFolder;
			const body = (await res.json()) as {
				id: string;
				createdAt: string;
			};
			await waitUntil(
				async () => {
					const file = await fetchMirror(folder, "contact.xlsx");
					if (file === null) return false;
					const parsed = await readRows(file);
					return parsed.rows[1]?.[0] === body.id;
				},
				5000,
				50,
			);

			const names = await listMirror(folder);
			expect(names).toEqual(["contact.xlsx"]);

			const bytes = await fetchMirror(folder, "contact.xlsx");
			expect(bytes).not.toBeNull();
			const { sheet, rows } = await readRows(bytes as Buffer);
			expect(sheet).toBe("contact");
			expect(rows[0]).toEqual([
				"id",
				"email",
				"name",
				"age",
				"createdAt",
				"updatedAt",
			]);
			expect(rows[1]?.[0]).toBe(body.id);
			expect(rows[1]?.[1]).toBe("a@example.invalid");
			expect(rows[1]?.[2]).toBe("A");
			expect(rows[1]?.[3]).toBe(41);

			const after = await app.db
				.collection<{
					_id: string;
					mirroredSeq?: number;
					contentHash?: string;
					lastWrittenEtag?: string | null;
				}>("mirror_state")
				.findOne({ _id: "contact" });
			expect(after?.mirroredSeq).toBe(1);
			expect(after?.contentHash).toMatch(/^[0-9a-f]{64}$/);
			expect(after?.lastWrittenEtag).toBeTruthy();

			const res2 = await app.fetch("/v1/contact", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: "b@example.invalid",
					name: "B",
					age: 42,
				}),
			});
			expect(res2.status).toBe(201);
			await waitUntil(
				async () => {
					const file = await fetchMirror(folder, "contact.xlsx");
					if (file === null) return false;
					const parsed = await readRows(file);
					return parsed.rows.length >= 3;
				},
				5000,
				50,
			);

			const bytes2 = await fetchMirror(folder, "contact.xlsx");
			const { rows: rows2 } = await readRows(bytes2 as Buffer);
			expect(rows2.length).toBe(3);

			const logText = app.logs.lines().join("\n");
			expect(logText).not.toContain("a@example.invalid");
			expect(logText).not.toContain(folder);
		} finally {
			await app.close();
		}
	});
});
