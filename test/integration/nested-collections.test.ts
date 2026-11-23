import { describe, expect, it } from "vitest";
import { collectionsApp, newKey } from "../helpers/collections-app.ts";
import {
	fetchMirror,
	listMirror,
	readRows,
	waitUntil,
} from "../helpers/mirror.ts";

const key = newKey();
const eventsOnlyKey = newKey();

const SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["email"],
	properties: {
		email: { type: "string", maxLength: 254, format: "email" },
		name: { type: "string", maxLength: 100 },
	},
};

describe("nested collections: routes, grants, mirror folders", () => {
	it("serves flat and nested collections alongside each other", async () => {
		const app = await collectionsApp({
			role: "all",
			mirror: true,
			mirrorTimings: { pollMs: 50, debounceMs: 200 },
			collections: {
				events: {
					schema: SCHEMA,
					operations: { create: "anonymous", get: "apiKey", list: "apiKey" },
					rateLimit: { max: 10_000, windowSeconds: 60 },
				},
				"events/2026/signups": {
					schema: SCHEMA,
					operations: {
						create: "anonymous",
						get: "apiKey",
						list: "apiKey",
						replace: "apiKey",
						patch: "apiKey",
						delete: "apiKey",
					},
					rateLimit: { max: 10_000, windowSeconds: 60 },
				},
			},
			keys: [
				{
					name: "staff",
					key,
					grants: [
						"events/2026/signups:get",
						"events/2026/signups:list",
						"events/2026/signups:replace",
						"events/2026/signups:patch",
						"events/2026/signups:delete",
						"events:get",
						"events:list",
					],
				},
				{ name: "events-only", key: eventsOnlyKey, grants: ["events:get"] },
			],
		});
		try {
			const auth = `Bearer ${key}`;
			const nestedCreate = await app.fetch("/v1/events/2026/signups", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email: "nested@example.invalid", name: "N" }),
			});
			expect(nestedCreate.status).toBe(201);
			const nestedBody = (await nestedCreate.json()) as { id: string };
			const nestedGet = await app.fetch(
				`/v1/events/2026/signups/${nestedBody.id}`,
				{ headers: { authorization: auth } },
			);
			expect(nestedGet.status).toBe(200);
			expect((await nestedGet.json()) as { email: string }).toEqual(
				expect.objectContaining({ email: "nested@example.invalid" }),
			);

			const listRes = await app.fetch("/v1/events/2026/signups", {
				headers: { authorization: auth },
			});
			expect(listRes.status).toBe(200);
			const listBody = (await listRes.json()) as { items: { id: string }[] };
			expect(listBody.items.map((item) => item.id)).toContain(nestedBody.id);

			const putRes = await app.fetch(
				`/v1/events/2026/signups/${nestedBody.id}`,
				{
					method: "PUT",
					headers: {
						authorization: auth,
						"content-type": "application/json",
						"if-match": nestedGet.headers.get("etag") ?? '"1"',
					},
					body: JSON.stringify({
						email: "patched@example.invalid",
						name: "P",
					}),
				},
			);
			expect(putRes.status).toBe(200);

			const patchRes = await app.fetch(
				`/v1/events/2026/signups/${nestedBody.id}`,
				{
					method: "PATCH",
					headers: {
						authorization: auth,
						"content-type": "application/merge-patch+json",
						"if-match": putRes.headers.get("etag") ?? '"2"',
					},
					body: JSON.stringify({ name: "Patched" }),
				},
			);
			expect(patchRes.status).toBe(200);

			const stored = await app.db
				.collection<{ _id: string; data: { email: string } }>(
					"records_events/2026/signups",
				)
				.findOne({ _id: nestedBody.id });
			expect(stored?.data?.email).toBe("patched@example.invalid");

			const folder = app.mirrorFolder;
			await waitUntil(
				async () =>
					(await fetchMirror(folder, "events/2026/signups.xlsx")) !== null,
				5000,
				50,
			);
			const nestedBytes = await fetchMirror(folder, "events/2026/signups.xlsx");
			expect(nestedBytes).not.toBeNull();
			const nestedSheet = await readRows(nestedBytes as Buffer, "signups");
			expect(nestedSheet.sheet).toBe("signups");
			expect(nestedSheet.rows.some((row) => row[0] === nestedBody.id)).toBe(
				true,
			);

			const flatCreate = await app.fetch("/v1/events", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: "flat@example.invalid",
					name: "F",
				}),
			});
			expect(flatCreate.status).toBe(201);
			const flatList = await app.fetch("/v1/events", {
				headers: { authorization: auth },
			});
			expect(flatList.status).toBe(200);
			const flatItems = (await flatList.json()) as {
				items: { email: string }[];
			};
			expect(
				flatItems.items.every(
					(item) => item.email !== "nested@example.invalid",
				),
			).toBe(true);

			const ambiguous = await app.fetch("/v1/events/2026", {
				headers: { authorization: auth },
			});
			expect(ambiguous.status).toBe(404);
			expect(ambiguous.headers.get("content-type")).toContain(
				"application/problem+json",
			);

			const forbidden = await app.fetch(
				`/v1/events/2026/signups/${nestedBody.id}`,
				{ headers: { authorization: `Bearer ${eventsOnlyKey}` } },
			);
			expect(forbidden.status).toBe(403);

			const delRes = await app.fetch(
				`/v1/events/2026/signups/${nestedBody.id}`,
				{
					method: "DELETE",
					headers: {
						authorization: auth,
						"if-match": patchRes.headers.get("etag") ?? '"3"',
					},
				},
			);
			expect(delRes.status).toBe(204);

			await waitUntil(
				async () => (await fetchMirror(folder, "events.xlsx")) !== null,
				5000,
				50,
			);
			const topNames = await listMirror(folder);
			expect(topNames).toEqual(
				expect.arrayContaining(["events", "events.xlsx"]),
			);

			const nestedFolderList = await listMirror(folder, "events/2026");
			expect(nestedFolderList).toEqual(["signups.xlsx"]);
		} finally {
			await app.close();
		}
	});
});
