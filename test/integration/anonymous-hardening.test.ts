import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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

describe("honeypot", () => {
	const reader = newKey();
	const READ = { authorization: `Bearer ${reader}` };
	const UUID_V4 =
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
	let trap: CollectionsApp;

	beforeAll(async () => {
		trap = await collectionsApp({
			collections: {
				contact: {
					schema: {
						type: "object",
						additionalProperties: false,
						required: ["email", "name"],
						properties: {
							email: { type: "string", maxLength: 254 },
							name: { type: "string", maxLength: 100 },
						},
					},
					operations: { create: "anonymous", get: "apiKey" },
					honeypot: "website",
					rateLimit: { max: 10000, windowSeconds: 60 },
				},
			},
			keys: [{ name: "reader", key: reader, grants: ["contact:get"] }],
		});
	});

	afterAll(async () => {
		await trap?.close();
	});

	const stored = () => trap.db.collection("records_contact").countDocuments();
	const valid = { email: "a@example.invalid", name: "Ada" };

	function submit(body: unknown, headers: Record<string, string> = {}) {
		return trap.app.inject({
			method: "POST",
			url: "/v1/contact",
			headers: { "content-type": "application/json", ...headers },
			payload: JSON.stringify(body),
		});
	}

	/** The log lines one request adds; waits for the onResponse line. */
	async function logged(run: () => Promise<unknown>) {
		const before = trap.logs.lines().length;
		await run();
		await vi.waitFor(() =>
			expect(trap.logs.lines().length).toBeGreaterThan(before),
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		return trap.logs.lines().slice(before);
	}

	it("creates for real when the honeypot is empty, and stores no honeypot key", async () => {
		const res = await submit({ ...valid, website: "" });
		expect(res.statusCode).toBe(201);
		const { id } = res.json();
		const doc = await trap.db
			.collection("records_contact")
			.findOne({ _id: id });
		expect(doc).not.toBeNull();
		expect(Object.keys(doc?.data ?? {}).sort()).toEqual(["email", "name"]);
	});

	it("creates for real when the honeypot is absent", async () => {
		const before = await stored();
		const res = await submit(valid);
		expect(res.statusCode).toBe(201);
		expect(await stored()).toBe(before + 1);
	});

	it("creates for real when the honeypot is null, without storing it", async () => {
		const before = await stored();
		const res = await submit({ ...valid, website: null });
		expect(res.statusCode).toBe(201);
		expect(await stored()).toBe(before + 1);
		const doc = await trap.db
			.collection("records_contact")
			.findOne({ _id: res.json().id });
		expect(Object.keys(doc?.data ?? {}).sort()).toEqual(["email", "name"]);
	});

	it("answers a filled honeypot with a fake 201 and stores nothing", async () => {
		const before = await stored();
		const res = await submit({ ...valid, website: "http://spam.example" });
		expect(res.statusCode).toBe(201);
		expect(res.headers.etag).toBe('"1"');
		const body = res.json();
		expect(Object.keys(body).sort()).toEqual(["createdAt", "id"]);
		expect(body.id).toMatch(UUID_V4);
		expect(Math.abs(Date.now() - Date.parse(body.createdAt))).toBeLessThan(
			60_000,
		);
		expect(await stored()).toBe(before);
		const got = await trap.app.inject({
			method: "GET",
			url: `/v1/contact/${body.id}`,
			headers: READ,
		});
		expect(got.statusCode).toBe(404);
	});

	it.each([[" "], [0], [false], [{}], [[]]])(
		"treats %j as filled",
		async (value) => {
			const before = await stored();
			const res = await submit({ ...valid, website: value });
			expect(res.statusCode).toBe(201);
			expect(res.headers.etag).toBe('"1"');
			expect(await stored()).toBe(before);
		},
	);

	it("gives the fake 201 even when the rest of the body is invalid", async () => {
		const before = await stored();
		for (const body of [
			{ website: "x", extra: 1, email: "a@example.invalid", name: "Ada" },
			{ website: "x" },
			{ website: "x", email: 5 },
		]) {
			const res = await submit(body);
			expect(res.statusCode).toBe(201);
			expect(Object.keys(res.json()).sort()).toEqual(["createdAt", "id"]);
		}
		expect(await stored()).toBe(before);
	});

	it("gives each fake response a fresh id", async () => {
		const a = await submit({ ...valid, website: "x" });
		const b = await submit({ ...valid, website: "x" });
		expect(a.json().id).not.toBe(b.json().id);
	});

	it("is not bypassed by a valid API key (D-05)", async () => {
		const before = await stored();
		const res = await submit({ ...valid, website: "x" }, READ);
		expect(res.statusCode).toBe(201);
		expect(res.headers.etag).toBe('"1"');
		expect(await stored()).toBe(before);
	});

	it("looks like a real create: same status, header names and body keys", async () => {
		const real = await submit(valid);
		const fake = await submit({ ...valid, website: "x" });
		const names = (headers: Record<string, unknown>) =>
			Object.keys(headers)
				.filter((name) => name !== "date")
				.sort();
		expect(fake.statusCode).toBe(real.statusCode);
		expect(names(fake.headers)).toEqual(names(real.headers));
		expect(fake.headers["content-type"]).toBe(real.headers["content-type"]);
		expect(Object.keys(fake.json()).sort()).toEqual(
			Object.keys(real.json()).sort(),
		);
	});

	it("writes one log line, shaped like a real create's, with no submitted text", async () => {
		const [real] = await logged(() => submit(valid));
		const lines = await logged(() =>
			submit({ email: CANARY, name: CANARY, website: CANARY }),
		);
		expect(lines).toHaveLength(1);
		const shape = (line: string | undefined) => {
			const entry = JSON.parse(line ?? "{}");
			return { keys: Object.keys(entry.req).sort(), route: entry.req.route };
		};
		const fake = JSON.parse(lines[0] ?? "{}");
		expect(fake.res.status).toBe(201);
		expect(Object.keys(fake).sort()).toEqual(
			Object.keys(JSON.parse(real ?? "{}")).sort(),
		);
		expect(shape(lines[0])).toEqual(shape(real));
		expect(trap.logs.lines().join("\n")).not.toMatch(CANARY_PATTERN);
	});

	it("carries no submitted text in the response", async () => {
		const res = await submit({ email: CANARY, name: CANARY, website: CANARY });
		expect(res.body).not.toMatch(CANARY_PATTERN);
		expect(JSON.stringify(res.headers)).not.toMatch(CANARY_PATTERN);
	});
});
