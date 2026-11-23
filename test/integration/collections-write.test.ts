import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Collection, type Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { stringify } from "yaml";
import { buildApp } from "../../src/app.ts";
import { loadConfig } from "../../src/config/load.ts";
import {
	type CollectionsApp,
	collectionsApp,
	newKey,
} from "../helpers/collections-app.ts";
import { STACK } from "./global-setup.ts";

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
					patch: "apiKey",
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
					"contact:patch",
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
			(await put(created.id, NEW_BODY, { "if-match": '"7", "2"' })).status,
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

const MERGE_PATCH = "application/merge-patch+json";
const CANARY = "CANARY-7f3a";

function patch(
	id: string,
	body: unknown,
	headers: Record<string, string> = {},
	raw = false,
): Promise<Response> {
	return app.fetch(`/v1/contact/${id}`, {
		method: "PATCH",
		headers: { ...bearer, "content-type": MERGE_PATCH, ...headers },
		body: raw ? (body as string) : JSON.stringify(body),
	});
}

describe("PATCH /v1/{name}/{id}", () => {
	it("applies a merge patch, changes only the named field and bumps the version", async () => {
		const created = await create();
		await sleep(3);
		const res = await patch(created.id, { name: "B" });
		expect(res.status).toBe(200);
		expect(etagVersion(res)).toBe("v2");
		const body = (await res.json()) as Created;
		expect(body).toEqual({
			email: "a@example.invalid",
			name: "B",
			age: 30,
			id: created.id,
			createdAt: created.createdAt,
			updatedAt: body.updatedAt,
		});
		expect(body.updatedAt > created.updatedAt).toBe(true);
		const doc = await stored(created.id);
		expect(doc?._v).toBe(2);
		expect(doc?.data).toEqual({
			email: "a@example.invalid",
			name: "B",
			age: 30,
		});
	});

	it("null removes an optional field", async () => {
		const created = await create();
		const res = await patch(created.id, { age: null });
		expect(res.status).toBe(200);
		expect("age" in ((await res.json()) as object)).toBe(false);
		expect((await stored(created.id))?.data).toEqual({
			email: "a@example.invalid",
			name: "A",
		});
	});

	it("rejects a patch that removes a required field, leaving record and version alone", async () => {
		const created = await create();
		const res = await patch(created.id, { email: null });
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

	it("an empty patch re-validates, bumps the version and updatedAt, and answers 200", async () => {
		const created = await create();
		await sleep(3);
		const res = await patch(created.id, {});
		expect(res.status).toBe(200);
		expect(etagVersion(res)).toBe("v2");
		const body = (await res.json()) as Created;
		expect(body.updatedAt > created.updatedAt).toBe(true);
		expect(body.name).toBe("A");
	});

	it.each([
		["an array", "[]"],
		["a string", '"x"'],
		["a number", "5"],
		["null", "null"],
	])("%s as the patch gives 400", async (_label, raw) => {
		const created = await create();
		const res = await patch(created.id, raw, {}, true);
		expect(res.status).toBe(400);
		expect((await stored(created.id))?._v).toBe(1);
	});

	it.each([
		["an unknown property", { nickname: "x" }],
		["a wrong type", { age: "x" }],
		["an id", { id: "x" }],
		["createdAt", { createdAt: "2020-01-01T00:00:00.000Z" }],
		["updatedAt", { updatedAt: "2020-01-01T00:00:00.000Z" }],
	])("%s gives 400 and changes nothing", async (_label, body) => {
		const created = await create();
		expect((await patch(created.id, body)).status).toBe(400);
		expect((await stored(created.id))?._v).toBe(1);
	});

	it("rejects a __proto__ key in the parser with 400", async () => {
		const created = await create();
		const res = await patch(created.id, '{"__proto__":{"x":1}}', {}, true);
		expect(res.status).toBe(400);
		expect(res.headers.get("content-type")).toContain(
			"application/problem+json",
		);
		expect((await stored(created.id))?._v).toBe(1);
		expect(({} as Record<string, unknown>).x).toBeUndefined();
	});

	it("rejects constructor.prototype in the parser with 400", async () => {
		const created = await create();
		const raw = '{"constructor":{"prototype":{"x":1}}}';
		expect((await patch(created.id, raw, {}, true)).status).toBe(400);
	});

	it("answers 415 for PATCH with application/json and for PUT with merge-patch", async () => {
		const created = await create();
		const wrongPatch = await patch(
			created.id,
			{ name: "B" },
			{ "content-type": "application/json" },
		);
		expect(wrongPatch.status).toBe(415);
		expect(wrongPatch.headers.get("content-type")).toContain(
			"application/problem+json",
		);
		const wrongPut = await put(created.id, NEW_BODY, {
			"content-type": MERGE_PATCH,
		});
		expect(wrongPut.status).toBe(415);
		expect((await stored(created.id))?._v).toBe(1);
	});

	it("accepts charset parameters on the media type", async () => {
		const created = await create();
		const res = await patch(
			created.id,
			{ name: "B" },
			{ "content-type": `${MERGE_PATCH}; charset=utf-8` },
		);
		expect(res.status).toBe(200);
	});

	it("honours If-Match: 412 when stale, 200 when current", async () => {
		const created = await create();
		const stale = await patch(created.id, { name: "B" }, { "if-match": '"2"' });
		expect(stale.status).toBe(412);
		expect((await stored(created.id))?._v).toBe(1);
		const current = await patch(
			created.id,
			{ name: "B" },
			{ "if-match": '"1"' },
		);
		expect(current.status).toBe(200);
		expect(etagVersion(current)).toBe("v2");
		expect(
			(await patch(created.id, { name: "C" }, { "if-match": "*" })).status,
		).toBe(200);
	});

	it("answers 404 for an id that is not stored, also with If-Match", async () => {
		const id = crypto.randomUUID();
		const res = await patch(id, { name: "B" });
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain(
			"application/problem+json",
		);
		expect((await patch(id, { name: "B" }, { "if-match": '"1"' })).status).toBe(
			404,
		);
	});

	it("two PATCHes without If-Match that set different fields both land", async () => {
		for (let round = 0; round < 8; round++) {
			const created = await create();
			const [one, two] = await Promise.all([
				patch(created.id, { name: "Changed" }),
				patch(created.id, { age: 99 }),
			]);
			expect(one.status).toBe(200);
			expect(two.status).toBe(200);
			const doc = await stored(created.id);
			expect(doc?.data).toEqual({
				email: "a@example.invalid",
				name: "Changed",
				age: 99,
			});
			expect(doc?._v).toBe(3);
		}
	});

	it("401 without a key and 403 without the patch grant", async () => {
		const created = await create();
		const anonymous = await app.fetch(`/v1/contact/${created.id}`, {
			method: "PATCH",
			headers: { "content-type": MERGE_PATCH },
			body: JSON.stringify({ name: "B" }),
		});
		expect(anonymous.status).toBe(401);
		const reader = await patch(
			created.id,
			{ name: "B" },
			{ authorization: `Bearer ${getOnlyKey}` },
		);
		expect(reader.status).toBe(403);
		expect((await stored(created.id))?._v).toBe(1);
	});

	it("never echoes a rejected value or key in the body or any log line", async () => {
		const created = await create();
		const value = `${CANARY}@example.invalid`;
		const res = await patch(created.id, {
			email: value,
			[value]: value,
		});
		expect(res.status).toBe(400);
		expect(await res.text()).not.toMatch(/canary-7f3a/i);
		for (const line of app.logs.lines()) {
			expect(line).not.toMatch(/canary-7f3a/i);
		}
	});
});

describe("PATCH retry on a lost version race", () => {
	let scratch: string;
	let client: MongoClient;
	let realDb: Db;
	let attempts: number;
	let interferences: number;
	const raceKey = newKey();

	/** A Db whose findOneAndUpdate is preceded by another writer's version bump, `interferences` times. */
	function racingDb(db: Db): Db {
		const wrapCollection = (collection: Collection) =>
			new Proxy(collection, {
				get(target, prop) {
					if (prop === "findOneAndUpdate") {
						return async (filter: { _id: string }, ...rest: unknown[]) => {
							attempts++;
							if (interferences > 0) {
								interferences--;
								await target.updateOne(
									{ _id: filter._id as never },
									{
										$inc: { _v: 1 },
									},
								);
							}
							return (
								target.findOneAndUpdate as (...args: unknown[]) => unknown
							).call(target, filter, ...rest);
						};
					}
					const value = Reflect.get(target, prop);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		return new Proxy(db, {
			get(target, prop) {
				if (prop === "collection") {
					return (name: string) => wrapCollection(target.collection(name));
				}
				const value = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}

	let app2: ReturnType<typeof buildApp>;

	beforeAll(async () => {
		const runId = inject("runId");
		const dbName = `it-${runId}-collections-race`;
		const uri = `${STACK.mongoUri}/${dbName}`;
		scratch = mkdtempSync(join(tmpdir(), "snook-race-"));
		const file = join(scratch, "config.yaml");
		writeFileSync(
			file,
			stringify({
				mongo: { uri },
				storage: {
					webdav: {
						url: STACK.webdavUrl,
						username: STACK.webdavUser,
						password: STACK.webdavPassword,
					},
				},
				mounts: { live: { path: `/run-${runId}`, mode: "read-write" } },
				mirror: { mount: "live" },
				collections: {
					contact: {
						schema: {
							type: "object",
							additionalProperties: false,
							required: ["name"],
							properties: { name: { type: "string", maxLength: 100 } },
						},
						operations: { create: "apiKey", patch: "apiKey" },
					},
				},
				apiKeys: [
					{
						name: "racer",
						hash: createHash("sha256").update(raceKey).digest("hex"),
						grants: ["contact:create", "contact:patch"],
					},
				],
			}),
		);
		const config = loadConfig({ CONFIG_FILE: file });
		client = new MongoClient(uri);
		realDb = client.db();
		app2 = buildApp({
			logger: { level: "silent" },
			collections: { config, db: racingDb(realDb) },
		});
		await app2.ready();
	});

	afterAll(async () => {
		await app2?.close();
		await realDb?.dropDatabase().catch(() => undefined);
		await client?.close().catch(() => undefined);
		rmSync(scratch, { recursive: true, force: true });
	});

	async function seed(): Promise<string> {
		const res = await app2.inject({
			method: "POST",
			url: "/v1/contact",
			headers: {
				authorization: `Bearer ${raceKey}`,
				"content-type": "application/json",
			},
			payload: { name: "start" },
		});
		expect(res.statusCode).toBe(201);
		return (res.json() as { id: string }).id;
	}

	function send(id: string) {
		return app2.inject({
			method: "PATCH",
			url: `/v1/contact/${id}`,
			headers: {
				authorization: `Bearer ${raceKey}`,
				"content-type": MERGE_PATCH,
			},
			payload: { name: "patched" },
		});
	}

	it("retries on the version it read and lands on the third attempt", async () => {
		const id = await seed();
		attempts = 0;
		interferences = 2;
		const res = await send(id);
		expect(res.statusCode).toBe(200);
		expect(attempts).toBe(3);
		const doc = await realDb
			.collection("records_contact")
			.findOne({ _id: id as never });
		expect(doc?._v).toBe(4);
		expect(doc?.data).toEqual({ name: "patched" });
	});

	it("gives 409 after three lost races and changes nothing", async () => {
		const id = await seed();
		attempts = 0;
		interferences = 3;
		const res = await send(id);
		expect(res.statusCode).toBe(409);
		expect(res.headers["content-type"]).toContain("application/problem+json");
		expect(attempts).toBe(3);
		const doc = await realDb
			.collection("records_contact")
			.findOne({ _id: id as never });
		expect(doc?.data).toEqual({ name: "start" });
		// Only the interfering writer's three bumps happened.
		expect(doc?._v).toBe(4);
	});
});
