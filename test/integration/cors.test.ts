import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type CollectionsApp,
	collectionsApp,
	newKey,
} from "../helpers/collections-app.ts";

const ALLOWED = "https://www.example.org";
const EVIL = "https://evil.example";
const key = newKey();

const schema = {
	type: "object",
	additionalProperties: false,
	required: ["email"],
	properties: { email: { type: "string", maxLength: 254 } },
};

let app: CollectionsApp;

beforeAll(async () => {
	app = await collectionsApp({
		collections: {
			contact: {
				schema,
				operations: { create: "anonymous", get: "apiKey" },
				cors: { origins: [ALLOWED] },
			},
			other: {
				schema,
				operations: { create: "anonymous" },
			},
		},
		keys: [{ name: "reader", key, grants: ["contact:get"] }],
	});
});

afterAll(async () => {
	await app?.close();
});

const BODY = JSON.stringify({ email: "a@example.invalid" });

function post(path: string, headers: Record<string, string> = {}) {
	return app.app.inject({
		method: "POST",
		url: path,
		headers: { "content-type": "application/json", ...headers },
		payload: BODY,
	});
}

const count = (name: string) =>
	app.db.collection(`records_${name}`).countDocuments();

describe("CORS on an anonymous create", () => {
	it("answers a listed origin with its own allow-origin and Vary: Origin", async () => {
		const res = await post("/v1/contact", { origin: ALLOWED });
		expect(res.statusCode).toBe(201);
		expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
		expect(String(res.headers.vary).toLowerCase()).toContain("origin");
		expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
	});

	it("rejects an unlisted origin with 403 problem+json and stores nothing", async () => {
		const before = await count("contact");
		const res = await post("/v1/contact", { origin: EVIL });
		expect(res.statusCode).toBe(403);
		expect(String(res.headers["content-type"])).toContain(
			"application/problem+json",
		);
		expect(res.headers["access-control-allow-origin"]).toBeUndefined();
		expect(await count("contact")).toBe(before);
	});

	it("rejects Origin: null", async () => {
		const res = await post("/v1/contact", { origin: "null" });
		expect(res.statusCode).toBe(403);
	});

	it("rejects an origin that only starts like a listed one", async () => {
		const res = await post("/v1/contact", {
			origin: `${ALLOWED}.evil.example`,
		});
		expect(res.statusCode).toBe(403);
	});

	it("lets a request without Origin through", async () => {
		const res = await post("/v1/contact");
		expect(res.statusCode).toBe(201);
	});

	it("rejects before the body is read: a body that is not JSON still gives 403", async () => {
		const res = await app.app.inject({
			method: "POST",
			url: "/v1/contact",
			headers: { "content-type": "application/json", origin: EVIL },
			payload: "{not json",
		});
		expect(res.statusCode).toBe(403);
	});
});

describe("preflight", () => {
	it("answers a listed origin with 204 and the collection's allowances", async () => {
		const res = await app.app.inject({
			method: "OPTIONS",
			url: "/v1/contact",
			headers: {
				origin: ALLOWED,
				"access-control-request-method": "POST",
				"access-control-request-headers": "content-type",
			},
		});
		expect(res.statusCode).toBe(204);
		expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
		const methods = String(res.headers["access-control-allow-methods"]);
		expect(methods).toContain("POST");
		expect(methods).toContain("GET");
		expect(methods).not.toContain("DELETE");
		const headers = String(
			res.headers["access-control-allow-headers"],
		).toLowerCase();
		for (const name of [
			"content-type",
			"idempotency-key",
			"if-match",
			"authorization",
		]) {
			expect(headers).toContain(name);
		}
		expect(res.headers["access-control-max-age"]).toBe("600");
	});

	it("refuses the same preflight from an unlisted origin with 403", async () => {
		const res = await app.app.inject({
			method: "OPTIONS",
			url: "/v1/contact",
			headers: { origin: EVIL, "access-control-request-method": "POST" },
		});
		expect(res.statusCode).toBe(403);
		expect(res.headers["access-control-allow-origin"]).toBeUndefined();
	});

	it("also answers a preflight for a record path", async () => {
		const res = await app.app.inject({
			method: "OPTIONS",
			url: "/v1/contact/abc",
			headers: { origin: ALLOWED, "access-control-request-method": "GET" },
		});
		expect(res.statusCode).toBe(204);
		expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
	});

	it("does not count toward the anonymous rate limit", async () => {
		const res = await app.app.inject({
			method: "OPTIONS",
			url: "/v1/contact",
			headers: { origin: ALLOWED, "access-control-request-method": "POST" },
		});
		expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
	});
});

describe("CORS on an apiKey route", () => {
	it("is not bypassed by a valid key", async () => {
		const created = await post("/v1/contact");
		const { id } = created.json() as { id: string };
		const res = await app.app.inject({
			method: "GET",
			url: `/v1/contact/${id}`,
			headers: { authorization: `Bearer ${key}`, origin: EVIL },
		});
		expect(res.statusCode).toBe(403);
	});

	it("answers a listed origin and exposes ETag", async () => {
		const created = await post("/v1/contact");
		const { id } = created.json() as { id: string };
		const res = await app.app.inject({
			method: "GET",
			url: `/v1/contact/${id}`,
			headers: { authorization: `Bearer ${key}`, origin: ALLOWED },
		});
		expect(res.statusCode).toBe(200);
		expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED);
		const exposed = String(
			res.headers["access-control-expose-headers"],
		).toLowerCase();
		expect(exposed).toContain("etag");
		expect(exposed).toContain("retry-after");
	});
});

describe("a collection without a cors block", () => {
	it("rejects every request that carries an Origin", async () => {
		const res = await post("/v1/other", { origin: ALLOWED });
		expect(res.statusCode).toBe(403);
	});

	it("accepts a request without Origin", async () => {
		const res = await post("/v1/other");
		expect(res.statusCode).toBe(201);
	});
});
