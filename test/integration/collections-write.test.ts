import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type CollectionsApp,
	collectionsApp,
	newKey,
} from "../helpers/collections-app.ts";

const key = newKey();
const getOnlyKey = newKey();

let app: CollectionsApp;

beforeAll(async () => {
	app = await collectionsApp({
		collections: {
			contact: {
				schema: {
					type: "object",
					additionalProperties: false,
					required: ["email", "name"],
					properties: {
						email: { type: "string", format: "email", maxLength: 254 },
						name: { type: "string", maxLength: 100 },
						age: { type: "integer" },
					},
				},
				operations: {
					create: "apiKey",
					get: "apiKey",
					replace: "apiKey",
					delete: "apiKey",
				},
			},
		},
		keys: [
			{
				name: "writer",
				key,
				grants: [
					"contact:create",
					"contact:get",
					"contact:replace",
					"contact:delete",
				],
			},
			{ name: "reader", key: getOnlyKey, grants: ["contact:get"] },
		],
	});
});

afterAll(async () => {
	await app?.close();
});

const bearer = { authorization: `Bearer ${key}` };
const jsonHeaders = { ...bearer, "content-type": "application/json" };

type Created = Record<string, unknown> & {
	id: string;
	createdAt: string;
	updatedAt: string;
};

async function create(
	body: Record<string, unknown> = {
		email: "a@example.invalid",
		name: "A",
		age: 30,
	},
): Promise<Created> {
	const res = await app.fetch("/v1/contact", {
		method: "POST",
		headers: jsonHeaders,
		body: JSON.stringify(body),
	});
	expect(res.status).toBe(201);
	return (await res.json()) as Created;
}

function put(
	id: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<Response> {
	return app.fetch(`/v1/contact/${id}`, {
		method: "PUT",
		headers: { ...jsonHeaders, ...headers },
		body: JSON.stringify(body),
	});
}

function get(id: string): Promise<Response> {
	return app.fetch(`/v1/contact/${id}`, { headers: bearer });
}

function del(id: string, headers: Record<string, string> = bearer) {
	return app.fetch(`/v1/contact/${id}`, { method: "DELETE", headers });
}

function stored(id: string) {
	return app.db.collection("records_contact").findOne({ _id: id as never });
}

/** "v2" for a well-formed ETag "2"; the raw value otherwise. Keeps quotes out of TAP failure output. */
const etagVersion = (res: Response): string | null =>
	res.headers.get("etag")?.replace(/^"(\d+)"$/, "v$1") ?? null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const NEW_BODY = { email: "b@example.invalid", name: "B" };

describe("PUT /v1/{name}/{id}", () => {
	it("replaces the record, drops fields the body omits and bumps the version", async () => {
		const created = await create();
		await sleep(3);
		const res = await put(created.id, NEW_BODY);
		expect(res.status).toBe(200);
		expect(etagVersion(res)).toBe("v2");
		const body = (await res.json()) as Created;
		expect(body).toEqual({
			...NEW_BODY,
			id: created.id,
			createdAt: created.createdAt,
			updatedAt: body.updatedAt,
		});
		expect("age" in body).toBe(false);
		expect(body.updatedAt > created.updatedAt).toBe(true);

		const again = await get(created.id);
		expect(etagVersion(again)).toBe("v2");
		expect(await again.json()).toEqual(body);
		expect((await stored(created.id))?.data).toEqual(NEW_BODY);
	});

	it("a PUT with an unchanged body still bumps the version", async () => {
		const created = await create(NEW_BODY);
		const res = await put(created.id, NEW_BODY);
		expect(res.status).toBe(200);
		expect(etagVersion(res)).toBe("v2");
	});

	it("honours a matching If-Match once and answers 412 on the stale value", async () => {
		const created = await create();
		expect(etagVersion(await put(created.id, NEW_BODY))).toBe("v2");

		const ok = await put(created.id, NEW_BODY, { "if-match": '"2"' });
		expect(ok.status).toBe(200);
		expect(etagVersion(ok)).toBe("v3");

		const stale = await put(
			created.id,
			{ email: "c@example.invalid", name: "C" },
			{ "if-match": '"2"' },
		);
		expect(stale.status).toBe(412);
		expect(stale.headers.get("content-type")).toContain(
			"application/problem+json",
		);
		const doc = await stored(created.id);
		expect(doc?._v).toBe(3);
		expect(doc?.data).toEqual(NEW_BODY);
	});

	it("treats If-Match as a strong comparison", async () => {
		const created = await create();
		expect(
			(await put(created.id, NEW_BODY, { "if-match": 'W/"1"' })).status,
		).toBe(412);
		expect((await put(created.id, NEW_BODY, { "if-match": "1" })).status).toBe(
			412,
		);
		expect((await put(created.id, NEW_BODY, { "if-match": "*" })).status).toBe(
			200,
		);
		expect(
			(await put(created.id, NEW_BODY, { "if-match": '"7", "3"' })).status,
		).toBe(200);
	});

	it("two PUTs with the same If-Match give one 200 and one 412", async () => {
		const created = await create();
		const bodies = [
			{ email: "one@example.invalid", name: "One" },
			{ email: "two@example.invalid", name: "Two" },
		];
		const responses = await Promise.all(
			bodies.map((body) => put(created.id, body, { "if-match": '"1"' })),
		);
		// Joined: TAP failure output must stay on one line to count as RED evidence.
		expect(
			responses
				.map((r) => r.status)
				.sort()
				.join(","),
		).toBe("200,412");
		const winner = responses.findIndex((r) => r.status === 200);
		const doc = await stored(created.id);
		expect(doc?.data).toEqual(bodies[winner]);
		expect(doc?._v).toBe(2);
	});

	it.each([
		["an extra property", { ...NEW_BODY, nickname: "x" }],
		["a wrong type", { email: "b@example.invalid", name: 5 }],
		["an id", { ...NEW_BODY, id: "x" }],
		["createdAt", { ...NEW_BODY, createdAt: "2020-01-01T00:00:00.000Z" }],
		["updatedAt", { ...NEW_BODY, updatedAt: "2020-01-01T00:00:00.000Z" }],
		["a missing required field", { name: "B" }],
		["an array", [NEW_BODY]],
	])("rejects %s with 400 and changes nothing", async (_label, body) => {
		const created = await create();
		const res = await put(created.id, body);
		expect(res.status).toBe(400);
		expect(res.headers.get("content-type")).toContain(
			"application/problem+json",
		);
		const doc = await stored(created.id);
		expect(doc?._v).toBe(1);
		expect(doc?.data).toEqual({
			email: "a@example.invalid",
			name: "A",
			age: 30,
		});
	});

	it("answers 404 for an id that is not stored, also with If-Match", async () => {
		const id = crypto.randomUUID();
		const res = await put(id, NEW_BODY);
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain(
			"application/problem+json",
		);
		expect((await put(id, NEW_BODY, { "if-match": '"1"' })).status).toBe(404);
		expect((await put(id, NEW_BODY, { "if-match": "*" })).status).toBe(404);
	});

	it("answers 415 for a media type other than application/json", async () => {
		const created = await create();
		const res = await app.fetch(`/v1/contact/${created.id}`, {
			method: "PUT",
			headers: { ...bearer, "content-type": "text/plain" },
			body: JSON.stringify(NEW_BODY),
		});
		expect(res.status).toBe(415);
		expect((await stored(created.id))?._v).toBe(1);
	});
});

describe("DELETE /v1/{name}/{id}", () => {
	it("hard-deletes the document and answers 204 with an empty body", async () => {
		const created = await create();
		const res = await del(created.id);
		expect(res.status).toBe(204);
		expect(await res.text()).toBe("");
		expect(
			await app.db
				.collection("records_contact")
				.countDocuments({ _id: created.id as never }),
		).toBe(0);
	});

	it("answers 404 problem+json for a second DELETE and for GET", async () => {
		const created = await create();
		expect((await del(created.id)).status).toBe(204);
		const second = await del(created.id);
		expect(second.status).toBe(404);
		expect(second.headers.get("content-type")).toContain(
			"application/problem+json",
		);
		expect((await get(created.id)).status).toBe(404);
	});

	it("answers 404 for an id that was never stored", async () => {
		expect((await del(crypto.randomUUID())).status).toBe(404);
	});

	it("ignores If-Match", async () => {
		const created = await create();
		const res = await del(created.id, { ...bearer, "if-match": '"99"' });
		expect(res.status).toBe(204);
	});
});

describe("authentication on PUT and DELETE", () => {
	it("403 without the replace or delete grant", async () => {
		const created = await create();
		const reader = { authorization: `Bearer ${getOnlyKey}` };
		const put403 = await put(created.id, NEW_BODY, reader);
		expect(put403.status).toBe(403);
		const del403 = await del(created.id, reader);
		expect(del403.status).toBe(403);
		const doc = await stored(created.id);
		expect(doc?._v).toBe(1);
	});

	it("401 without a key", async () => {
		const created = await create();
		const putRes = await app.fetch(`/v1/contact/${created.id}`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(NEW_BODY),
		});
		expect(putRes.status).toBe(401);
		expect(putRes.headers.get("www-authenticate")).toBe("Bearer");
		expect(
			(await app.fetch(`/v1/contact/${created.id}`, { method: "DELETE" }))
				.status,
		).toBe(401);
		expect(await stored(created.id)).not.toBeNull();
	});
});
