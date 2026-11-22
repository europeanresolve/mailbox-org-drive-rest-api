import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalHash, entryId } from "../../src/collections/idempotency.ts";
import {
	type CollectionsApp,
	collectionsApp,
	newKey,
} from "../helpers/collections-app.ts";

const CANARY = "CANARY-7f3a@example.invalid";
const CANARY_PATTERN = /canary-7f3a/i;
const keyA = newKey();
const keyB = newKey();
const AUTH_A = { authorization: `Bearer ${keyA}` };
const AUTH_B = { authorization: `Bearer ${keyB}` };
const JSON_HEADERS = { "content-type": "application/json" };

const schema = {
	type: "object",
	additionalProperties: false,
	required: ["email"],
	properties: {
		email: { type: "string", maxLength: 254 },
		note: { type: "string", maxLength: 1000 },
	},
};

let app: CollectionsApp;

beforeAll(async () => {
	app = await collectionsApp({
		collections: {
			contact: {
				schema,
				operations: { create: "anonymous" },
				honeypot: "website",
				// The default limit of 10 a minute would answer 429 mid-suite.
				rateLimit: { max: 10000, windowSeconds: 60 },
			},
			staff: {
				schema,
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
				name: "key-a",
				key: keyA,
				grants: ["staff:create", "staff:get", "staff:replace", "staff:delete"],
			},
			{ name: "key-b", key: keyB, grants: ["staff:create"] },
		],
	});
});

afterAll(async () => {
	await app?.close();
});

const unique = () => `${randomUUID()}@example.invalid`;
const entries = () => app.db.collection("_idempotency");
const entryFor = (collection: string, key: string) =>
	entries().findOne({ _id: entryId(collection, key) as never });
const countRecords = (collection: string, email: string) =>
	app.db
		.collection(`records_${collection}`)
		.countDocuments({ "data.email": email });

function create(
	collection: "contact" | "staff",
	payload: unknown,
	options: { key?: string; auth?: Record<string, string> } = {},
) {
	return app.app.inject({
		method: "POST",
		url: `/v1/${collection}`,
		headers: {
			...JSON_HEADERS,
			...(collection === "staff" ? (options.auth ?? AUTH_A) : {}),
			...(options.key === undefined ? {} : { "idempotency-key": options.key }),
		},
		payload: JSON.stringify(payload),
	});
}

const isProblem = (res: { headers: Record<string, unknown> }) =>
	String(res.headers["content-type"]).includes("application/problem+json");

type PendingOptions = {
	lockedAgoMs: number;
	createdAgoMs?: number;
	principal?: string;
	recordId?: string;
};

/** Writes a pending entry the way a crashed or slow request would have left it. */
async function seedPending(
	collection: string,
	key: string,
	body: unknown,
	options: PendingOptions,
) {
	const now = Date.now();
	const recordId = options.recordId ?? randomUUID();
	await entries().insertOne({
		_id: entryId(collection, key) as never,
		principal: options.principal ?? "anonymous",
		bodyHash: canonicalHash(body),
		status: "pending",
		recordId,
		createdAt: new Date(now - (options.createdAgoMs ?? options.lockedAgoMs)),
		lockedAt: new Date(now - options.lockedAgoMs),
	});
	return recordId;
}

describe("replay", () => {
	it("returns the original 201, ETag and body for the same key and body, storing one record", async () => {
		const email = unique();
		const first = await create("contact", { email }, { key: "k1" });
		expect(first.statusCode).toBe(201);
		expect(first.headers.etag).toBe('"1"');
		const { id } = first.json();

		const second = await create("contact", { email }, { key: "k1" });
		expect(second.statusCode).toBe(201);
		expect(second.headers.etag).toBe('"1"');
		expect(second.body).toBe(first.body);
		expect(second.json().id).toBe(id);
		expect(await countRecords("contact", email)).toBe(1);
	});

	it("treats the same body with its keys reordered as the same body", async () => {
		const email = unique();
		const first = await create("contact", { email, note: "n" }, { key: "k2" });
		const second = await create("contact", { note: "n", email }, { key: "k2" });
		expect(second.statusCode).toBe(201);
		expect(second.body).toBe(first.body);
		expect(await countRecords("contact", email)).toBe(1);
	});

	it("answers 422 problem+json for the same key with a different body", async () => {
		const email = unique();
		await create("contact", { email }, { key: "k3" });
		const other = unique();
		const res = await create("contact", { email: other }, { key: "k3" });
		expect(res.statusCode).toBe(422);
		expect(isProblem(res)).toBe(true);
		expect(await countRecords("contact", other)).toBe(0);
	});

	it("scopes a key per collection", async () => {
		const email = unique();
		const a = await create("contact", { email }, { key: "shared" });
		const b = await create("staff", { email }, { key: "shared" });
		expect(a.statusCode).toBe(201);
		expect(b.statusCode).toBe(201);
		expect(a.json().id).not.toBe(b.json().id);
		expect(await countRecords("contact", email)).toBe(1);
		expect(await countRecords("staff", email)).toBe(1);
	});

	it("answers 422 to another API key reusing the key, and never shows the first key's record", async () => {
		const email = unique();
		const first = await create("staff", { email }, { key: "k4" });
		expect(first.statusCode).toBe(201);
		const res = await create("staff", { email }, { key: "k4", auth: AUTH_B });
		expect(res.statusCode).toBe(422);
		expect(isProblem(res)).toBe(true);
		expect(res.body).not.toContain(first.json().id);
		expect(await countRecords("staff", email)).toBe(1);
	});

	it("replays the original full record even after a PUT changed it", async () => {
		const email = unique();
		const first = await create("staff", { email, note: "v1" }, { key: "k5" });
		const { id } = first.json();
		const put = await app.app.inject({
			method: "PUT",
			url: `/v1/staff/${id}`,
			headers: { ...JSON_HEADERS, ...AUTH_A },
			payload: JSON.stringify({ email, note: "v2" }),
		});
		expect(put.statusCode).toBe(200);

		const replay = await create("staff", { email, note: "v1" }, { key: "k5" });
		expect(replay.statusCode).toBe(201);
		expect(replay.headers.etag).toBe('"1"');
		expect(replay.body).toBe(first.body);
		expect(replay.json().note).toBe("v1");
	});

	it("behaves as before without the header", async () => {
		const email = unique();
		const a = await create("contact", { email });
		const b = await create("contact", { email });
		expect(a.statusCode).toBe(201);
		expect(b.statusCode).toBe(201);
		expect(a.json().id).not.toBe(b.json().id);
		expect(await countRecords("contact", email)).toBe(2);
	});

	it("ignores the header on operations other than create", async () => {
		const email = unique();
		const { id } = (await create("staff", { email })).json();
		const get = await app.app.inject({
			method: "GET",
			url: `/v1/staff/${id}`,
			headers: { ...AUTH_A, "idempotency-key": "" },
		});
		expect(get.statusCode).toBe(200);
	});
});

describe("concurrency and recovery", () => {
	it("stores exactly one record for five parallel creates with one key", async () => {
		const email = unique();
		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				create("contact", { email }, { key: "parallel" }),
			),
		);
		const statuses = results.map((r) => r.statusCode);
		expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
		expect(statuses).toContain(201);
		const ids = new Set(
			results.filter((r) => r.statusCode === 201).map((r) => r.json().id),
		);
		expect(ids.size).toBe(1);
		for (const r of results.filter((x) => x.statusCode === 409)) {
			expect(isProblem(r)).toBe(true);
		}
		expect(await countRecords("contact", email)).toBe(1);
	});

	it("answers 409 problem+json while a younger pending entry holds the key", async () => {
		const email = unique();
		await seedPending("contact", "busy", { email }, { lockedAgoMs: 10_000 });
		const res = await create("contact", { email }, { key: "busy" });
		expect(res.statusCode).toBe(409);
		expect(isProblem(res)).toBe(true);
		expect(await countRecords("contact", email)).toBe(0);
	});

	it("takes over a pending entry locked more than 30 s ago and reuses its record id", async () => {
		const email = unique();
		const recordId = await seedPending(
			"contact",
			"stale",
			{ email },
			{ lockedAgoMs: 60_000 },
		);
		const res = await create("contact", { email }, { key: "stale" });
		expect(res.statusCode).toBe(201);
		expect(res.json().id).toBe(recordId);
		expect(await countRecords("contact", email)).toBe(1);

		const replay = await create("contact", { email }, { key: "stale" });
		expect(replay.statusCode).toBe(201);
		expect(replay.body).toBe(res.body);
	});

	it("returns a record already stored under the entry's id instead of a second one", async () => {
		const email = unique();
		const recordId = randomUUID();
		const at = new Date().toISOString();
		await app.db.collection("records_contact").insertOne({
			_id: recordId as never,
			_v: 1,
			createdAt: at,
			updatedAt: at,
			data: { email },
		});
		await seedPending(
			"contact",
			"crashed",
			{ email },
			{ lockedAgoMs: 60_000, recordId },
		);
		const res = await create("contact", { email }, { key: "crashed" });
		expect(res.statusCode).toBe(201);
		expect(res.json()).toEqual({ id: recordId, createdAt: at });
		expect(await countRecords("contact", email)).toBe(1);
	});

	it("does not take over an entry of another principal", async () => {
		const email = unique();
		await seedPending(
			"staff",
			"foreign",
			{ email },
			{ lockedAgoMs: 60_000, principal: "key-b" },
		);
		const res = await create("staff", { email }, { key: "foreign" });
		expect(res.statusCode).toBe(422);
		expect(await countRecords("staff", email)).toBe(0);
	});

	it("treats an entry older than 24 h as absent, even before the TTL monitor ran", async () => {
		const email = unique();
		const oldId = randomUUID();
		await entries().insertOne({
			_id: entryId("contact", "aged") as never,
			principal: "anonymous",
			bodyHash: canonicalHash({ email }),
			status: "complete",
			recordId: oldId,
			createdAt: new Date(Date.now() - 25 * 3600_000),
			lockedAt: new Date(Date.now() - 25 * 3600_000),
			response: {
				status: 201,
				etag: '"1"',
				body: { id: oldId, createdAt: "2020-01-01T00:00:00.000Z" },
			},
		});
		const res = await create("contact", { email }, { key: "aged" });
		expect(res.statusCode).toBe(201);
		expect(res.json().id).not.toBe(oldId);
		expect(await countRecords("contact", email)).toBe(1);
	});
});

describe("what writes no entry", () => {
	it("a 400 leaves the key free for a corrected body", async () => {
		const bad = await create("contact", { note: "no email" }, { key: "k9" });
		expect(bad.statusCode).toBe(400);
		expect(await entryFor("contact", "k9")).toBeNull();

		const email = unique();
		const good = await create("contact", { email }, { key: "k9" });
		expect(good.statusCode).toBe(201);
		expect(await entryFor("contact", "k9")).not.toBeNull();
	});

	it("a filled honeypot gets the fake 201 and writes no entry", async () => {
		const res = await create(
			"contact",
			{ email: unique(), website: "http://spam.invalid" },
			{ key: "bot" },
		);
		expect(res.statusCode).toBe(201);
		expect(await entryFor("contact", "bot")).toBeNull();
	});

	it("a refused request (401, 415) writes no entry", async () => {
		const unauth = await app.app.inject({
			method: "POST",
			url: "/v1/staff",
			headers: { ...JSON_HEADERS, "idempotency-key": "refused" },
			payload: JSON.stringify({ email: unique() }),
		});
		expect(unauth.statusCode).toBe(401);
		const wrongType = await app.app.inject({
			method: "POST",
			url: "/v1/contact",
			headers: { "content-type": "text/plain", "idempotency-key": "refused" },
			payload: "x",
		});
		expect(wrongType.statusCode).toBe(415);
		expect(await entryFor("staff", "refused")).toBeNull();
		expect(await entryFor("contact", "refused")).toBeNull();
	});
});

describe("key format", () => {
	it.each([
		["empty", ""],
		["256 characters", "k".repeat(256)],
		["containing a space", "a b"],
		["non-ASCII", "schlüssel"],
	])("answers 400 problem+json for a key that is %s", async (_label, key) => {
		const email = unique();
		const res = await create("contact", { email }, { key });
		expect(res.statusCode).toBe(400);
		expect(isProblem(res)).toBe(true);
		expect(await countRecords("contact", email)).toBe(0);
	});

	it("accepts a key of 255 characters", async () => {
		const res = await create(
			"contact",
			{ email: unique() },
			{ key: "k".repeat(255) },
		);
		expect(res.statusCode).toBe(201);
	});
});

describe("hard delete", () => {
	it("removes the idempotency entry with the record, so a retry creates a new record", async () => {
		const email = unique();
		const first = await create("staff", { email }, { key: "k-del" });
		const { id } = first.json();
		expect(await entryFor("staff", "k-del")).not.toBeNull();

		const del = await app.app.inject({
			method: "DELETE",
			url: `/v1/staff/${id}`,
			headers: AUTH_A,
		});
		expect(del.statusCode).toBe(204);
		expect(await entryFor("staff", "k-del")).toBeNull();
		expect(await entries().countDocuments({ recordId: id as never })).toBe(0);

		const retry = await create("staff", { email }, { key: "k-del" });
		expect(retry.statusCode).toBe(201);
		expect(retry.json().id).not.toBe(id);
	});
});

describe("indexes", () => {
	it("has a 24 h TTL index on createdAt and an index on recordId", async () => {
		await vi.waitFor(async () => {
			const indexes = await entries().indexes();
			const ttl = indexes.find((i) => i.key.createdAt === 1);
			expect(ttl?.expireAfterSeconds).toBe(86400);
			expect(indexes.some((i) => i.key.recordId === 1)).toBe(true);
		});
	});

	it("stores createdAt as a BSON Date", async () => {
		await create("contact", { email: unique() }, { key: "date-check" });
		const entry = await entryFor("contact", "date-check");
		expect(entry?.createdAt).toBeInstanceOf(Date);
	});
});

describe("what a key and its refusals reveal", () => {
	it("keeps the raw key out of 409 and 422 responses, logs and stored entries", async () => {
		const email = unique();
		const first = await create("contact", { email }, { key: CANARY });
		expect(first.statusCode).toBe(201);
		const mismatch = await create(
			"contact",
			{ email: `${unique()}`, note: CANARY },
			{ key: CANARY },
		);
		expect(mismatch.statusCode).toBe(422);

		const busyKey = `${CANARY}-busy`;
		await seedPending("contact", busyKey, { email }, { lockedAgoMs: 5_000 });
		const busy = await create("contact", { email }, { key: busyKey });
		expect(busy.statusCode).toBe(409);

		for (const res of [mismatch, busy]) {
			expect(res.body).not.toMatch(CANARY_PATTERN);
			expect(JSON.stringify(res.headers)).not.toMatch(CANARY_PATTERN);
		}
		await vi.waitFor(() => {
			expect(
				app.logs.lines().filter((l) => /"status":422/.test(l)).length,
			).toBeGreaterThan(0);
		});
		expect(app.logs.lines().join("\n")).not.toMatch(CANARY_PATTERN);
		const stored = JSON.stringify(await entries().find().toArray());
		expect(stored).not.toMatch(CANARY_PATTERN);
	});
});
