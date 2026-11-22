import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type CollectionsApp,
	collectionsApp,
	newKey,
} from "../helpers/collections-app.ts";

// Phase 2 end-to-end sweep (COLL-07, T-02-34): through start(), every error path of
// the collections API is triggered with the canary in every place a client controls,
// and neither a response body, a header nor a log line may carry it back.
const CANARY = "CANARY-7f3a@example.invalid";
const CANARY_PATTERN = /canary-7f3a/i;
const BODY_LIMIT = 512;
const RATE_MAX = 5;
const STAFF_ID = "11111111-1111-4111-8111-111111111111";

const reader = newKey();
const limited = newKey();
const unknown = newKey();

const contactSchema = {
	type: "object",
	additionalProperties: false,
	required: ["email", "status"],
	properties: {
		email: { type: "string", maxLength: 254 },
		status: { type: "string", maxLength: 20 },
		note: { type: "string", maxLength: 200 },
	},
};
const staffSchema = {
	type: "object",
	additionalProperties: false,
	required: ["name", "status"],
	properties: {
		name: { type: "string", maxLength: 100 },
		status: { type: "string", maxLength: 20 },
	},
};

let app: CollectionsApp;

beforeAll(async () => {
	app = await collectionsApp({
		collections: {
			contact: {
				schema: contactSchema,
				operations: { create: "anonymous" },
				indexes: ["status"],
				honeypot: "website",
				cors: { origins: ["https://www.example.org"] },
				rateLimit: { max: RATE_MAX, windowSeconds: 60 },
				bodyLimit: BODY_LIMIT,
			},
			staff: {
				schema: staffSchema,
				operations: {
					get: "apiKey",
					list: "apiKey",
					replace: "apiKey",
					patch: "apiKey",
					delete: "apiKey",
				},
				indexes: ["status"],
			},
		},
		keys: [
			{
				name: "reader",
				key: reader,
				grants: [
					"staff:get",
					"staff:list",
					"staff:replace",
					"staff:patch",
					"staff:delete",
				],
			},
			{ name: "limited", key: limited, grants: ["staff:get"] },
		],
	});
	const now = new Date().toISOString();
	await app.db.collection("records_staff").insertOne({
		_id: STAFF_ID as never,
		_v: 1,
		createdAt: now,
		updatedAt: now,
		data: { name: "Synthetic Person", status: "active" },
	});
});

afterAll(async () => {
	await app?.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Logged = {
	msg: string;
	req?: { route?: string };
	res?: { status: number };
};

const requestLines = (): Logged[] =>
	app.logs
		.lines()
		.map((line) => JSON.parse(line) as Logged)
		.filter((entry) => entry.msg === "request");

/** Runs one request and checks the response and the single log line it wrote. */
async function sweep(
	send: () => Promise<{
		statusCode: number;
		headers: Record<string, unknown>;
		body: string;
	}>,
	expected: number,
	{ problem = true }: { problem?: boolean } = {},
) {
	const before = requestLines().length;
	const res = await send();
	expect(res.statusCode).toBe(expected);
	expect(res.body).not.toMatch(CANARY_PATTERN);
	expect(JSON.stringify(res.headers)).not.toMatch(CANARY_PATTERN);
	if (problem) {
		expect(String(res.headers["content-type"])).toContain(
			"application/problem+json",
		);
	}
	// onResponse runs just after the client has the answer.
	for (let i = 0; i < 100 && requestLines().length <= before; i++) {
		await sleep(10);
	}
	await sleep(20);
	const lines = requestLines();
	expect(lines.length).toBe(before + 1);
	const route = lines.at(-1)?.req?.route;
	expect(typeof route).toBe("string");
	expect(route).toMatch(/^(\/|\(unmatched\))/);
	expect(lines.at(-1)?.res?.status).toBe(expected);
	return res;
}

const json = { "content-type": "application/json" };
const asReader = { authorization: `Bearer ${reader}` };

const call = (
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
	url: string,
	options: { headers?: Record<string, string>; payload?: string } = {},
) =>
	app.app.inject({
		method,
		url,
		headers: options.headers ?? {},
		...(options.payload === undefined ? {} : { payload: options.payload }),
	});

describe("Phase 2 error paths never echo the canary", () => {
	it("400 create validation: value, property name and query", async () => {
		await sweep(
			() =>
				call("POST", `/v1/contact?q=${CANARY}`, {
					headers: { ...json, "x-canary": CANARY },
					payload: JSON.stringify({
						email: CANARY,
						status: 7,
						[CANARY]: CANARY,
					}),
				}),
			400,
		);
	});

	it("400 list query: unknown parameter, bad limit, bad sort, bad cursor and a repeated key", async () => {
		for (const query of [
			`${encodeURIComponent(CANARY)}=x`,
			`status=a&limit=${encodeURIComponent(CANARY)}`,
			`sort=${encodeURIComponent(CANARY)}`,
			`cursor=${encodeURIComponent(CANARY)}`,
			`status=${encodeURIComponent(CANARY)}&status=${encodeURIComponent(CANARY)}`,
		]) {
			await sweep(
				() => call("GET", `/v1/staff?${query}`, { headers: asReader }),
				400,
			);
		}
	});

	it("401 without and with an unknown key", async () => {
		await sweep(() => call("GET", `/v1/staff/${CANARY}`), 401);
		await sweep(
			() =>
				call("GET", `/v1/staff/${CANARY}`, {
					headers: { authorization: `Bearer ${CANARY}` },
				}),
			401,
		);
		await sweep(
			() =>
				call("GET", `/v1/staff/${CANARY}`, {
					headers: { authorization: `Bearer ${unknown}` },
				}),
			401,
		);
	});

	it("403 for a key without the grant", async () => {
		await sweep(
			() =>
				call("DELETE", `/v1/staff/${CANARY}?x=${CANARY}`, {
					headers: { authorization: `Bearer ${limited}` },
				}),
			403,
		);
	});

	it("403 for an Origin that is not on the allow-list", async () => {
		await sweep(
			() =>
				call("POST", `/v1/contact?q=${CANARY}`, {
					headers: {
						...json,
						origin: `https://${CANARY.replace("@", ".")}`,
					},
					payload: JSON.stringify({ email: CANARY, status: "new" }),
				}),
			403,
		);
		await sweep(
			() =>
				call("POST", "/v1/contact", {
					headers: { ...json, origin: "null" },
					payload: JSON.stringify({ email: CANARY, status: "new" }),
				}),
			403,
		);
	});

	it("404 for an unknown record, an unconfigured operation and an unknown route", async () => {
		await sweep(
			() =>
				call("GET", `/v1/staff/${CANARY}?x=${CANARY}`, { headers: asReader }),
			404,
		);
		await sweep(() => call("GET", `/v1/contact/${CANARY}`), 404);
		await sweep(() => call("GET", `/v1/${CANARY}/${CANARY}`), 404);
		await sweep(
			() => call("DELETE", `/v1/staff/${CANARY}`, { headers: asReader }),
			404,
		);
	});

	it("412 for a stale If-Match on PUT and PATCH", async () => {
		await sweep(
			() =>
				call("PUT", `/v1/staff/${STAFF_ID}?x=${CANARY}`, {
					headers: { ...asReader, ...json, "if-match": '"99"' },
					payload: JSON.stringify({ name: CANARY, status: "active" }),
				}),
			412,
		);
		await sweep(
			() =>
				call("PATCH", `/v1/staff/${STAFF_ID}`, {
					headers: {
						...asReader,
						"content-type": "application/merge-patch+json",
						"if-match": CANARY,
					},
					payload: JSON.stringify({ name: CANARY }),
				}),
			412,
		);
	});

	it("400 for a PATCH that makes the record invalid", async () => {
		await sweep(
			() =>
				call("PATCH", `/v1/staff/${STAFF_ID}`, {
					headers: {
						...asReader,
						"content-type": "application/merge-patch+json",
					},
					payload: JSON.stringify({ name: 7, [CANARY]: CANARY }),
				}),
			400,
		);
	});

	it("415 for a wrong media type", async () => {
		await sweep(
			() =>
				call("POST", "/v1/contact", {
					headers: { "content-type": "text/plain", "x-canary": CANARY },
					payload: CANARY,
				}),
			415,
		);
		await sweep(
			() =>
				call("PATCH", `/v1/staff/${STAFF_ID}`, {
					headers: { ...asReader, ...json },
					payload: JSON.stringify({ name: CANARY }),
				}),
			415,
		);
	});

	it("413 for a body over the limit", async () => {
		await sweep(
			() =>
				call("POST", "/v1/contact", {
					headers: json,
					payload: JSON.stringify({
						email: CANARY,
						status: "new",
						note: CANARY.repeat(BODY_LIMIT),
					}),
				}),
			413,
		);
	});

	it("201 from the honeypot carries only a fake id and time", async () => {
		const res = await sweep(
			() =>
				call("POST", `/v1/contact?q=${CANARY}`, {
					headers: json,
					payload: JSON.stringify({
						email: CANARY,
						status: "new",
						website: CANARY,
					}),
				}),
			201,
			{ problem: false },
		);
		expect(Object.keys(res.json()).sort()).toEqual(["createdAt", "id"]);
		expect(await app.db.collection("records_contact").countDocuments()).toBe(0);
	});

	it("429 once the per-IP limit is spent", async () => {
		// The honeypot, 400, 413 and 415 cases above already used part of the bucket.
		let limitedAt = 0;
		for (let i = 0; i < RATE_MAX + 2 && limitedAt === 0; i++) {
			const res = await call("POST", `/v1/contact?q=${CANARY}`, {
				headers: json,
				payload: JSON.stringify({ email: CANARY, status: "new" }),
			});
			expect(res.body).not.toMatch(CANARY_PATTERN);
			if (res.statusCode === 429) limitedAt = i + 1;
		}
		expect(limitedAt).toBeGreaterThan(0);
		const res = await sweep(
			() =>
				call("POST", `/v1/contact?q=${CANARY}`, {
					headers: json,
					payload: JSON.stringify({ email: CANARY, status: "new" }),
				}),
			429,
		);
		expect(res.headers["retry-after"]).toBeDefined();
	});

	it("leaves the canary in no log line of the whole sweep", () => {
		const lines = app.logs.lines();
		expect(lines.length).toBeGreaterThan(20);
		for (const line of lines) expect(line).not.toMatch(CANARY_PATTERN);
		for (const key of [reader, limited, unknown]) {
			for (const line of lines) expect(line).not.toContain(key);
		}
	});
});

describe("server.docs through start()", () => {
	const collections = {
		contact: {
			schema: contactSchema,
			operations: { create: "anonymous" },
		},
	};

	it("is off by default and on with server.docs: true", async () => {
		const off = await collectionsApp({ collections });
		const on = await collectionsApp({ collections, server: { docs: true } });
		try {
			expect((await off.fetch("/docs/json")).status).toBe(404);
			const res = await on.fetch("/docs/json");
			expect(res.status).toBe(200);
			const doc = (await res.json()) as {
				openapi: string;
				paths: Record<string, unknown>;
			};
			expect(doc.openapi).toBe("3.1.0");
			expect(Object.keys(doc.paths)).toEqual([
				"/health",
				"/ready",
				"/v1/contact",
			]);
			expect((await on.fetch("/docs")).status).toBe(200);
		} finally {
			await off.close();
			await on.close();
		}
	});
});
