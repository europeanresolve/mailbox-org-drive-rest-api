import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type CollectionsApp,
	collectionsApp,
	newKey,
} from "../helpers/collections-app.ts";

const CANARY = "CANARY-7f3a@example.invalid";
const CANARY_PATTERN = /canary-7f3a/i;
const LIMIT = 256;
const key = newKey();
const AUTH = { authorization: `Bearer ${key}` };

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
				operations: { create: "anonymous", replace: "apiKey", patch: "apiKey" },
				bodyLimit: LIMIT,
				// The default limit of 10 a minute would answer 429 mid-suite.
				rateLimit: { max: 10000, windowSeconds: 60 },
			},
		},
		keys: [
			{
				name: "writer",
				key,
				grants: ["contact:replace", "contact:patch"],
			},
		],
	});
});

afterAll(async () => {
	await app?.close();
});

const count = () => app.db.collection("records_contact").countDocuments();

function post(
	payload: string,
	headers: Record<string, string> = { "content-type": "application/json" },
) {
	return app.app.inject({
		method: "POST",
		url: "/v1/contact",
		headers,
		payload,
	});
}

/** A JSON body of exactly `bytes` UTF-8 bytes, padded in `note` with `fill`. */
function bodyOfBytes(bytes: number, fill = "x", email = "a@example.invalid") {
	const base = JSON.stringify({ email, note: "" });
	const room = bytes - Buffer.byteLength(base);
	const unit = Buffer.byteLength(fill);
	if (room < 0 || room % unit !== 0) throw new Error("cannot fit body");
	const body = JSON.stringify({ email, note: fill.repeat(room / unit) });
	expect(Buffer.byteLength(body)).toBe(bytes);
	return body;
}

const isProblem = (res: { headers: Record<string, unknown> }) =>
	String(res.headers["content-type"]).includes("application/problem+json");

describe("body limit", () => {
	it("accepts a body of exactly bodyLimit bytes", async () => {
		const res = await post(bodyOfBytes(LIMIT));
		expect(res.statusCode).toBe(201);
	});

	it("answers 413 problem+json for one byte more, and stores nothing", async () => {
		const before = await count();
		const res = await post(bodyOfBytes(LIMIT + 1));
		expect(res.statusCode).toBe(413);
		expect(isProblem(res)).toBe(true);
		expect(await count()).toBe(before);
	});

	it("counts bytes, not characters", async () => {
		// 130 two-byte characters: well under 256 characters, over 256 bytes.
		const body = bodyOfBytes(LIMIT + 3, "é");
		expect(JSON.parse(body).note.length).toBeLessThan(LIMIT);
		const res = await post(body);
		expect(res.statusCode).toBe(413);
	});

	it("refuses a Content-Length over the limit without reading the body", async () => {
		const before = await count();
		const status = await new Promise<number>((resolve, reject) => {
			const req = httpRequest(
				`${app.url}/v1/contact`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"content-length": String(LIMIT * 100),
					},
				},
				(res) => {
					resolve(res.statusCode ?? 0);
					res.resume();
					req.destroy();
				},
			);
			req.on("error", reject);
			// The declared length is never sent.
			req.write('{"email":');
		});
		expect(status).toBe(413);
		expect(await count()).toBe(before);
	});

	it("stops a chunked body (no Content-Length) that grows past the limit", async () => {
		const before = await count();
		const status = await new Promise<number>((resolve, reject) => {
			const req = httpRequest(
				`${app.url}/v1/contact`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"transfer-encoding": "chunked",
					},
				},
				(res) => {
					resolve(res.statusCode ?? 0);
					res.resume();
				},
			);
			req.on("error", reject);
			req.write(
				`{"email":"a@example.invalid","note":"${"x".repeat(LIMIT * 4)}`,
			);
			req.end('"}');
		});
		expect(status).toBe(413);
		expect(await count()).toBe(before);
	});

	it("applies to PUT and PATCH too", async () => {
		const big = bodyOfBytes(LIMIT + 1);
		const put = await app.app.inject({
			method: "PUT",
			url: "/v1/contact/some-id",
			headers: { ...AUTH, "content-type": "application/json" },
			payload: big,
		});
		expect(put.statusCode).toBe(413);
		const patch = await app.app.inject({
			method: "PATCH",
			url: "/v1/contact/some-id",
			headers: { ...AUTH, "content-type": "application/merge-patch+json" },
			payload: big,
		});
		expect(patch.statusCode).toBe(413);
	});
});

describe("content type", () => {
	const body = JSON.stringify({ email: "a@example.invalid" });

	it.each([
		["text/plain"],
		["application/x-www-form-urlencoded"],
		["application/json; charset=latin1"],
		["application/merge-patch+json"],
	])("POST with %s gets 415 problem+json and stores nothing", async (type) => {
		const before = await count();
		const res = await post(body, { "content-type": type });
		expect(res.statusCode).toBe(415);
		expect(isProblem(res)).toBe(true);
		expect(await count()).toBe(before);
	});

	it("POST without a Content-Type gets 415", async () => {
		const before = await count();
		const res = await post(body, {});
		expect(res.statusCode).toBe(415);
		expect(isProblem(res)).toBe(true);
		expect(await count()).toBe(before);
	});

	it("answers 415 before the body is read: unparseable JSON of the wrong type", async () => {
		const res = await post("{not json", { "content-type": "text/plain" });
		expect(res.statusCode).toBe(415);
	});

	it.each([
		["application/json; charset=UTF-8"],
		["Application/JSON"],
		["application/json"],
	])("POST with %s gets 201", async (type) => {
		const res = await post(body, { "content-type": type });
		expect(res.statusCode).toBe(201);
	});

	it("PUT with application/merge-patch+json gets 415", async () => {
		const res = await app.app.inject({
			method: "PUT",
			url: "/v1/contact/some-id",
			headers: { ...AUTH, "content-type": "application/merge-patch+json" },
			payload: body,
		});
		expect(res.statusCode).toBe(415);
		expect(isProblem(res)).toBe(true);
	});

	it("PATCH with application/json gets 415", async () => {
		const res = await app.app.inject({
			method: "PATCH",
			url: "/v1/contact/some-id",
			headers: { ...AUTH, "content-type": "application/json" },
			payload: body,
		});
		expect(res.statusCode).toBe(415);
		expect(isProblem(res)).toBe(true);
	});

	it("PATCH with application/merge-patch+json; charset=utf-8 passes the media check", async () => {
		const res = await app.app.inject({
			method: "PATCH",
			url: "/v1/contact/missing-id",
			headers: {
				...AUTH,
				"content-type": "application/merge-patch+json; charset=utf-8",
			},
			payload: body,
		});
		expect(res.statusCode).toBe(404);
	});

	it("checks credentials before the media type", async () => {
		const res = await app.app.inject({
			method: "PUT",
			url: "/v1/contact/some-id",
			headers: { "content-type": "text/plain" },
			payload: body,
		});
		expect(res.statusCode).toBe(401);
	});
});

describe("what a 413 and a 415 reveal", () => {
	it("carry nothing from the body into the response or the logs", async () => {
		const tooBig = await post(bodyOfBytes(LIMIT + 1, "x", CANARY));
		expect(tooBig.statusCode).toBe(413);
		const wrongType = await post(JSON.stringify({ email: CANARY }), {
			"content-type": "text/plain",
		});
		expect(wrongType.statusCode).toBe(415);
		for (const res of [tooBig, wrongType]) {
			expect(res.body).not.toMatch(CANARY_PATTERN);
			expect(JSON.stringify(res.headers)).not.toMatch(CANARY_PATTERN);
		}
		const logs = app.logs.lines().join("\n");
		expect(logs).not.toMatch(CANARY_PATTERN);
	});
});
