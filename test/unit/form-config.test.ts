import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
	ConfigError,
	type ConfigIssue,
	loadConfig,
} from "../../src/config/load.ts";

const BOUNDED = {
	type: "object",
	additionalProperties: false,
	properties: { name: { type: "string", maxLength: 100 } },
};

/** A minimal valid document with one collection; `collection` overrides its keys. */
function load(collection: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "snook-form-"));
	try {
		const file = join(dir, "config.yaml");
		writeFileSync(
			file,
			stringify({
				mongo: { uri: "mongodb://localhost/x" },
				storage: {
					webdav: {
						url: "http://localhost:8080",
						username: "u",
						password: "p",
					},
				},
				mounts: { live: { path: "/live", mode: "read-write" } },
				collections: {
					contact: {
						schema: BOUNDED,
						operations: { create: "anonymous" },
						...collection,
					},
				},
			}),
		);
		return loadConfig({ CONFIG_FILE: file });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function issuesOf(run: () => unknown): readonly ConfigIssue[] {
	try {
		run();
	} catch (error) {
		if (error instanceof ConfigError) return error.issues;
		throw error;
	}
	return expect.fail("expected loadConfig to throw a ConfigError");
}

const codes = (issues: readonly ConfigIssue[]) =>
	issues.map((issue) => `${issue.code} ${issue.at}`);

const schemaWith = (properties: Record<string, unknown>) => ({
	type: "object",
	additionalProperties: false,
	properties,
});

describe("collections.<name>.bodyLimit", () => {
	it("defaults to 16384", () => {
		expect(load().collections.contact?.bodyLimit).toBe(16384);
	});

	it("accepts the largest allowed value", () => {
		expect(load({ bodyLimit: 1048576 }).collections.contact?.bodyLimit).toBe(
			1048576,
		);
	});

	it("rejects 0 with schema.minimum at the key", () => {
		expect(codes(issuesOf(() => load({ bodyLimit: 0 })))).toEqual([
			"schema.minimum /collections/contact/bodyLimit",
		]);
	});

	it("rejects 1048577 with schema.maximum at the key", () => {
		expect(codes(issuesOf(() => load({ bodyLimit: 1048577 })))).toEqual([
			"schema.maximum /collections/contact/bodyLimit",
		]);
	});
});

describe("strings in anonymous-write schemas", () => {
	const at = (pointer: string) => `collection.UNBOUNDED_STRING ${pointer}`;

	it("rejects a string with no maxLength, pointing at its schema", () => {
		const schema = schemaWith({ name: { type: "string" } });
		expect(codes(issuesOf(() => load({ schema })))).toEqual([
			at("/collections/contact/schema/properties/name"),
		]);
	});

	it("finds strings nested in objects, array items and anyOf branches", () => {
		const schema = schemaWith({
			address: schemaWith({ city: { type: "string" } }),
			tags: { type: "array", maxItems: 5, items: { type: "string" } },
			either: {
				anyOf: [{ type: "string", maxLength: 5 }, { type: "string" }],
			},
		});
		expect(codes(issuesOf(() => load({ schema })))).toEqual([
			at("/collections/contact/schema/properties/address/properties/city"),
			at("/collections/contact/schema/properties/tags/items"),
			at("/collections/contact/schema/properties/either/anyOf/1"),
		]);
	});

	it("finds a string inside a type list", () => {
		const schema = schemaWith({ note: { type: ["string", "null"] } });
		expect(codes(issuesOf(() => load({ schema })))).toEqual([
			at("/collections/contact/schema/properties/note"),
		]);
	});

	it("accepts strings bounded by enum or const", () => {
		const schema = schemaWith({
			kind: { type: "string", enum: ["a", "b"] },
			fixed: { const: "x" },
			typed: { type: "string", const: "y" },
		});
		expect(load({ schema }).collections.contact?.schema).toEqual(schema);
	});

	it("checks replace and patch as well as create", () => {
		const schema = schemaWith({ name: { type: "string" } });
		for (const operations of [
			{ create: "apiKey", replace: "anonymous" },
			{ create: "apiKey", patch: "anonymous" },
		]) {
			expect(codes(issuesOf(() => load({ schema, operations })))).toEqual([
				at("/collections/contact/schema/properties/name"),
			]);
		}
	});

	it("does not check a schema that no anonymous operation writes", () => {
		const schema = schemaWith({ name: { type: "string" } });
		const config = load({
			schema,
			operations: { create: "apiKey", get: "anonymous", list: "anonymous" },
		});
		expect(config.collections.contact?.schema).toEqual(schema);
	});

	it("loads the same schema when create requires an apiKey", () => {
		const schema = schemaWith({ name: { type: "string" } });
		const config = load({ schema, operations: { create: "apiKey" } });
		expect(config.collections.contact?.schema).toEqual(schema);
	});
});
