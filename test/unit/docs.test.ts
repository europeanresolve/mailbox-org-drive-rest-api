import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { buildApp } from "../../src/app.ts";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../../src/collections/list-query.ts";
import { ConfigError, loadConfig } from "../../src/config/load.ts";

type Json = Record<string, any>;

const CONTACT_SCHEMA = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	additionalProperties: false,
	required: ["name", "email", "status"],
	properties: {
		name: { type: "string", maxLength: 100 },
		email: { type: "string", maxLength: 254, format: "email" },
		status: { type: "string", maxLength: 20 },
		address: { $ref: "#/$defs/address" },
	},
	$defs: {
		address: {
			type: "object",
			additionalProperties: false,
			properties: { city: { type: "string", maxLength: 50 } },
		},
	},
};

const STAFF_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: { name: { type: "string", maxLength: 100 } },
};

const COLLECTIONS = {
	contact: {
		schema: CONTACT_SCHEMA,
		operations: {
			create: "anonymous",
			get: "apiKey",
			list: "apiKey",
			patch: "apiKey",
		},
		indexes: ["status"],
		cors: { origins: ["https://www.example.org"] },
	},
	staff: {
		schema: STAFF_SCHEMA,
		operations: { create: "apiKey", delete: "apiKey" },
	},
};

function writeConfig(
	server: Record<string, unknown> | undefined,
	collections: Record<string, unknown> | undefined,
) {
	const dir = mkdtempSync(join(tmpdir(), "snook-docs-"));
	try {
		const file = join(dir, "config.yaml");
		writeFileSync(
			file,
			stringify({
				...(server ? { server } : {}),
				mongo: { uri: "mongodb://127.0.0.1:1/docs" },
				storage: {
					webdav: {
						url: "http://localhost:8080",
						username: "u",
						password: "p",
					},
				},
				mounts: { live: { path: "/live", mode: "read-write" } },
				...(collections ? { collections } : {}),
			}),
		);
		return loadConfig({ CONFIG_FILE: file });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** The Mongo client connects lazily and no request here reaches it. */
function docsApp(
	server?: Record<string, unknown>,
	collections: Record<string, unknown> | undefined = COLLECTIONS,
) {
	const config = writeConfig(server, collections);
	const db = new MongoClient(config.mongo.uri).db();
	return buildApp({
		logger: { level: "silent" },
		checks: { mongoPing: async () => {}, driveState: () => "up" },
		collections: { config, db },
		docs: config.server.docs,
	});
}

async function documentOf(
	server: Record<string, unknown> | undefined = { docs: true },
	collections: Record<string, unknown> | undefined = COLLECTIONS,
): Promise<{ text: string; doc: Json }> {
	const app = docsApp(server, collections);
	try {
		const res = await app.inject({ method: "GET", url: "/docs/json" });
		expect(res.statusCode).toBe(200);
		return { text: res.body, doc: res.json() };
	} finally {
		await app.close();
	}
}

/** Every $ref in the document, walked without following it. */
function refsIn(node: unknown, found: string[] = []): string[] {
	if (Array.isArray(node)) {
		for (const item of node) refsIn(item, found);
	} else if (typeof node === "object" && node !== null) {
		for (const [key, value] of Object.entries(node)) {
			if (key === "$ref" && typeof value === "string") found.push(value);
			else refsIn(value, found);
		}
	}
	return found;
}

function resolve(doc: Json, ref: string): unknown {
	if (!ref.startsWith("#")) return undefined;
	let node: unknown = doc;
	for (const raw of ref.slice(1).split("/").slice(1)) {
		const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
		if (typeof node !== "object" || node === null || !(segment in node)) {
			return undefined;
		}
		node = (node as Json)[segment];
	}
	return node;
}

describe("server.docs config key", () => {
	it("defaults to false and accepts true", () => {
		expect(writeConfig(undefined, undefined).server.docs).toBe(false);
		expect(writeConfig({ docs: true }, undefined).server.docs).toBe(true);
	});

	it("rejects a non-boolean with schema.type at /server/docs", () => {
		try {
			writeConfig({ docs: "yes" }, undefined);
			expect.fail("expected a ConfigError");
		} catch (error) {
			if (!(error instanceof ConfigError)) throw error;
			expect(
				error.issues.map((issue) => `${issue.code} ${issue.at}`),
			).toContain("schema.type /server/docs");
		}
	});
});

describe("docs switched off (the default)", () => {
	it("answers /docs and /docs/json with a 404 problem+json", async () => {
		const app = docsApp(undefined);
		try {
			for (const url of ["/docs", "/docs/json", "/docs/yaml"]) {
				const res = await app.inject({ method: "GET", url });
				expect(res.statusCode).toBe(404);
				expect(res.headers["content-type"]).toMatch(
					/^application\/problem\+json/,
				);
			}
		} finally {
			await app.close();
		}
	});
});

describe("GET /docs/json", () => {
	it("is an OpenAPI 3.1.0 document with a bearer security scheme", async () => {
		const { doc } = await documentOf();
		expect(doc.openapi).toBe("3.1.0");
		expect(doc.info.title).toBe("mailbox-org-drive-rest-api");
		expect(doc.info.version).toEqual(expect.any(String));
		expect(doc.components.securitySchemes.bearerAuth).toEqual({
			type: "http",
			scheme: "bearer",
		});
	});

	it("lists exactly the configured routes and operations", async () => {
		const { doc } = await documentOf();
		expect(Object.keys(doc.paths)).toEqual([
			"/health",
			"/ready",
			"/v1/contact",
			"/v1/contact/{id}",
			"/v1/staff",
			"/v1/staff/{id}",
		]);
		const methods = (path: string) => Object.keys(doc.paths[path]).sort();
		expect(methods("/v1/contact")).toEqual(["get", "post"]);
		expect(methods("/v1/contact/{id}")).toEqual(["get", "patch"]);
		expect(methods("/v1/staff")).toEqual(["post"]);
		expect(methods("/v1/staff/{id}")).toEqual(["delete"]);
		for (const path of Object.keys(doc.paths)) {
			expect(path).not.toContain("*");
			expect(path).not.toContain("/docs");
		}
	});

	it("generates the component schemas from config, in config order", async () => {
		const { doc } = await documentOf();
		expect(Object.keys(doc.components.schemas)).toEqual([
			"contact.input",
			"contact.record",
			"contact.page",
			"staff.input",
			"staff.record",
			"staff.page",
			"AnonymousCreated",
			"Problem",
		]);
		expect(doc.components.schemas["contact.input"]).toEqual({
			...CONTACT_SCHEMA,
			properties: {
				...CONTACT_SCHEMA.properties,
				address: {
					$ref: "#/components/schemas/contact.input/$defs/address",
				},
			},
		});
		expect(doc.components.schemas["staff.input"]).toEqual(STAFF_SCHEMA);
		const record = doc.components.schemas["contact.record"];
		expect(Object.keys(record.properties)).toEqual(
			expect.arrayContaining(["name", "email", "status", "id"]),
		);
		expect(record.required).toEqual(
			expect.arrayContaining(["name", "id", "createdAt", "updatedAt"]),
		);
		expect(doc.components.schemas["contact.page"].properties.items).toEqual({
			type: "array",
			items: { $ref: "#/components/schemas/contact.record" },
		});
	});

	it("documents anonymous create: no security, id and createdAt only, Idempotency-Key", async () => {
		const { doc } = await documentOf();
		const post = doc.paths["/v1/contact"].post;
		expect(post.security).toEqual([]);
		expect(post.responses["201"].content["application/json"].schema).toEqual({
			$ref: "#/components/schemas/AnonymousCreated",
		});
		expect(post.requestBody.content["application/json"].schema).toEqual({
			$ref: "#/components/schemas/contact.input",
		});
		const key = post.parameters.find((p: Json) => p.name === "Idempotency-Key");
		expect(key).toMatchObject({ in: "header", required: false });
		for (const status of ["400", "403", "409", "413", "415", "422", "429"]) {
			expect(post.responses[status], status).toBeDefined();
		}
		expect(post.responses["401"]).toBeUndefined();
	});

	it("documents apiKey operations with bearerAuth, 401 and 403", async () => {
		const { doc } = await documentOf();
		const get = doc.paths["/v1/contact/{id}"].get;
		expect(get.security).toEqual([{ bearerAuth: [] }]);
		expect(get.responses["200"].content["application/json"].schema).toEqual({
			$ref: "#/components/schemas/contact.record",
		});
		expect(get.parameters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "id", in: "path", required: true }),
			]),
		);
		for (const status of ["401", "403", "404"]) {
			expect(get.responses[status], status).toBeDefined();
		}
		expect(get.responses["429"]).toBeUndefined();
		const staffPost = doc.paths["/v1/staff"].post;
		expect(staffPost.security).toEqual([{ bearerAuth: [] }]);
		expect(
			staffPost.responses["201"].content["application/json"].schema,
		).toEqual({ $ref: "#/components/schemas/staff.record" });
	});

	it("documents PATCH as merge-patch with If-Match, and delete as 204", async () => {
		const { doc } = await documentOf();
		const patch = doc.paths["/v1/contact/{id}"].patch;
		expect(Object.keys(patch.requestBody.content)).toEqual([
			"application/merge-patch+json",
		]);
		expect(patch.parameters).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "If-Match", in: "header" }),
			]),
		);
		for (const status of ["400", "404", "412", "413", "415"]) {
			expect(patch.responses[status], status).toBeDefined();
		}
		const remove = doc.paths["/v1/staff/{id}"].delete;
		expect(remove.responses["204"]).toBeDefined();
		expect(remove.responses["204"].content).toBeUndefined();
		expect(remove.requestBody).toBeUndefined();
	});

	it("gives every error status a problem+json body", async () => {
		const { doc } = await documentOf();
		let seen = 0;
		for (const [path, item] of Object.entries<Json>(doc.paths)) {
			if (!path.startsWith("/v1/")) continue;
			for (const operation of Object.values<Json>(item)) {
				for (const [status, response] of Object.entries<Json>(
					operation.responses,
				)) {
					if (Number(status) < 400) continue;
					seen++;
					expect(Object.keys(response.content)).toEqual([
						"application/problem+json",
					]);
					expect(response.content["application/problem+json"].schema).toEqual({
						$ref: "#/components/schemas/Problem",
					});
				}
			}
		}
		expect(seen).toBeGreaterThan(10);
	});

	it("documents list limit from the constants, cursor, sort and the indexed fields", async () => {
		const { doc } = await documentOf();
		const list = doc.paths["/v1/contact"].get;
		const param = (name: string) =>
			list.parameters.find((p: Json) => p.name === name);
		expect(param("limit").schema).toMatchObject({
			type: "integer",
			minimum: 1,
			maximum: MAX_LIMIT,
			default: DEFAULT_LIMIT,
		});
		expect(MAX_LIMIT).toBe(200);
		expect(DEFAULT_LIMIT).toBe(50);
		expect(param("cursor")).toMatchObject({ in: "query", required: false });
		expect(param("sort").schema.enum).toEqual(
			expect.arrayContaining(["createdAt", "-createdAt", "status", "-status"]),
		);
		expect(param("status")).toMatchObject({ in: "query" });
		expect(param("status").schema.type).toBe("string");
		expect(param("status.gte")).toBeDefined();
		expect(list.responses["200"].content["application/json"].schema).toEqual({
			$ref: "#/components/schemas/contact.page",
		});
	});

	it("resolves every $ref inside the document", async () => {
		const { doc } = await documentOf();
		const refs = refsIn(doc);
		expect(refs.length).toBeGreaterThan(10);
		expect(refs).toContain(
			"#/components/schemas/contact.input/$defs/address",
		);
		for (const ref of refs) {
			expect(resolve(doc, ref), ref).toBeDefined();
		}
	});

	it("is byte-identical across two runs", async () => {
		const first = await documentOf();
		const second = await documentOf();
		expect(first.text).toBe(second.text);
	});

	it("with no collections has only /health and /ready and no /v1 path", async () => {
		const { doc } = await documentOf({ docs: true }, undefined);
		expect(Object.keys(doc.paths)).toEqual(["/health", "/ready"]);
		expect(doc.openapi).toBe("3.1.0");
		expect(doc.components.securitySchemes.bearerAuth).toBeDefined();
	});
});

describe("GET /docs", () => {
	it("serves the UI as text/html", async () => {
		const app = docsApp({ docs: true });
		try {
			const res = await app.inject({ method: "GET", url: "/docs" });
			expect(res.statusCode).toBe(200);
			expect(res.headers["content-type"]).toMatch(/^text\/html/);
			expect(res.body).not.toMatch(/https?:\/\/(?!localhost)[a-z.-]+\/.*\.js/);
		} finally {
			await app.close();
		}
	});
});
