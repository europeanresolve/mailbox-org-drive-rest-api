import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type CollectionsApp,
	collectionsApp,
	newKey,
} from "../helpers/collections-app.ts";

const CANARY = "CANARY-7f3a";
const UUID_V4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const key1 = newKey();
const key2 = newKey();
const createOnlyKey = newKey();

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
				operations: { create: "anonymous", get: "apiKey" },
			},
		},
		keys: [
			{ name: "backend-one", key: key1, grants: ["contact:get"] },
			{ name: "backend-two", key: key2, grants: ["contact:get"] },
			{ name: "writer", key: createOnlyKey, grants: ["contact:create"] },
		],
	});
});

afterAll(async () => {
	await app?.close();
});

function post(body: unknown, headers: Record<string, string> = {}) {
	return app.fetch("/v1/contact", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

function get(id: string, authorization?: string) {
	return app.fetch(`/v1/contact/${id}`, {
		headers: authorization === undefined ? {} : { authorization },
	});
}

function stored() {
	return app.db.collection("records_contact").countDocuments();
}

async function create(): Promise<{ id: string; createdAt: string }> {
	const res = await post({ email: "a@example.invalid", name: "A" });
	expect(res.status).toBe(201);
	return (await res.json()) as { id: string; createdAt: string };
}

describe("tracer: anonymous create and apiKey get through start()", () => {
	it("creates anonymously with exactly { id, createdAt } and ETag 1", async () => {
		const res = await post({ email: "a@example.invalid", name: "A" });
		expect(res.status).toBe(201);
		expect(res.headers.get("etag")).toBe('"1"');
		const body = (await res.json()) as Record<string, string>;
		expect(Object.keys(body).sort()).toEqual(["createdAt", "id"]);
		expect(body.id).toMatch(UUID_V4);
		expect(body.createdAt).toMatch(ISO_Z);
	});

	it("reads the record back with either of two keys and stores user fields under data", async () => {
		const { id, createdAt } = await create();

		for (const key of [key1, key2]) {
			const res = await get(id, `Bearer ${key}`);
			expect(res.status).toBe(200);
			expect(res.headers.get("etag")).toBe('"1"');
			const body = (await res.json()) as Record<string, string>;
			expect(body).toEqual({
				id,
				createdAt,
				updatedAt: createdAt,
				email: "a@example.invalid",
				name: "A",
			});
		}

		const doc = await app.db
			.collection("records_contact")
			.findOne({ _id: id as never });
		expect(doc).toEqual({
			_id: id,
			_v: 1,
			createdAt,
			updatedAt: createdAt,
			data: { email: "a@example.invalid", name: "A" },
		});
	});

	describe("authentication on the apiKey operation", () => {
		it("401 with WWW-Authenticate for a missing header", async () => {
			const { id } = await create();
			const res = await get(id);
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toBe("Bearer");
			expect(res.headers.get("content-type")).toContain(
				"application/problem+json",
			);
		});

		it("401 for an unknown key of the right shape", async () => {
			const { id } = await create();
			const wrong = `mdra_${"A".repeat(43)}`;
			expect((await get(id, `Bearer ${wrong}`)).status).toBe(401);
		});

		it("401 for a header with two tokens", async () => {
			const { id } = await create();
			expect((await get(id, `Bearer ${key1} ${key2}`)).status).toBe(401);
		});

		it("matches the Bearer scheme case-insensitively", async () => {
			const { id } = await create();
			expect((await get(id, `bearer ${key1}`)).status).toBe(200);
		});

		it("403 for a valid key without the exact grant", async () => {
			const { id } = await create();
			const res = await get(id, `Bearer ${createOnlyKey}`);
			expect(res.status).toBe(403);
			expect(res.headers.get("content-type")).toContain(
				"application/problem+json",
			);
		});

		it("404 for an unknown id and for a malformed id, never 400", async () => {
			const auth = `Bearer ${key1}`;
			expect(
				(await get("5b0c3a4e-0000-4000-8000-000000000000", auth)).status,
			).toBe(404);
			expect((await get("not-an-id", auth)).status).toBe(404);
		});
	});

	describe("default deny", () => {
		it("answers 404 problem+json for operations without a policy, like an unknown path", async () => {
			const { id } = await create();
			const unknown = await app.fetch("/v1/nothing-here");
			const unknownBody = await unknown.json();
			expect(unknown.status).toBe(404);

			const auth = { authorization: `Bearer ${key1}` };
			const attempts: Array<[string, string]> = [
				["PUT", `/v1/contact/${id}`],
				["PATCH", `/v1/contact/${id}`],
				["DELETE", `/v1/contact/${id}`],
				["GET", "/v1/contact"],
			];
			for (const [method, path] of attempts) {
				const res = await app.fetch(path, {
					method,
					headers: { ...auth, "content-type": "application/json" },
					...(method === "PUT" || method === "PATCH" ? { body: "{}" } : {}),
				});
				expect(res.status, `${method} ${path}`).toBe(404);
				expect(res.headers.get("content-type")).toContain(
					"application/problem+json",
				);
				expect(await res.json()).toEqual(unknownBody);
			}
		});
	});

	describe("strict validation", () => {
		it("rejects a string for an integer field, an extra property and a name over maxLength", async () => {
			const before = await stored();
			const bad: unknown[] = [
				{ email: "a@example.invalid", name: "A", age: "1" },
				{ email: "a@example.invalid", name: "A", nickname: "x" },
				{ email: "a@example.invalid", name: "😀".repeat(101) },
			];
			for (const body of bad) {
				const res = await post(body);
				expect(res.status).toBe(400);
				expect(res.headers.get("content-type")).toContain(
					"application/problem+json",
				);
			}
			expect(await stored()).toBe(before);
		});

		it("counts maxLength in code points: 100 emoji pass, 101 fail", async () => {
			const ok = await post({
				email: "a@example.invalid",
				name: "😀".repeat(100),
			});
			expect(ok.status).toBe(201);
		});

		it("runs the schema on an empty object and rejects non-object bodies", async () => {
			expect((await post({})).status).toBe(400);
			expect((await post([])).status).toBe(400);
			expect((await post("text")).status).toBe(400);
			expect((await post(null)).status).toBe(400);
		});

		it("never echoes a submitted value or property name in the body or logs", async () => {
			const canaryEmail = `${CANARY}@example.invalid`;
			const cases: Array<Record<string, unknown>> = [
				{ email: canaryEmail, name: "A", age: "1" },
				{ email: canaryEmail, name: "A", [`${CANARY}-key`]: canaryEmail },
				{ email: "not-an-email", name: canaryEmail.repeat(10) },
			];
			for (const body of cases) {
				const res = await post(body);
				expect(res.status).toBe(400);
				const text = await res.text();
				expect(text).not.toMatch(/canary-7f3a/i);
				const parsed = JSON.parse(text) as {
					errors?: Array<{ keyword: string; pointer?: string }>;
				};
				expect(typeof parsed.errors?.[0]?.keyword).toBe("string");
			}
			const extra = await post({
				email: "a@example.invalid",
				name: "A",
				[`${CANARY}-key`]: 1,
			});
			const extraBody = (await extra.json()) as {
				errors: Array<{ pointer?: string }>;
			};
			for (const error of extraBody.errors) {
				expect(error.pointer ?? "").not.toMatch(/canary/i);
			}
			for (const line of app.logs.lines()) {
				expect(line).not.toMatch(/canary-7f3a/i);
			}
		});
	});

	it("ignores a wrong key on an anonymous operation", async () => {
		const res = await post(
			{ email: "a@example.invalid", name: "A" },
			{ authorization: `Bearer mdra_${"B".repeat(43)}` },
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as Record<string, string>;
		expect(Object.keys(body).sort()).toEqual(["createdAt", "id"]);
	});
});
