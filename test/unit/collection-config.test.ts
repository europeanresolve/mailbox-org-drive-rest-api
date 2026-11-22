import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ConfigError,
	type ConfigIssue,
	loadConfig,
} from "../../src/config/load.ts";

const FIXTURES = join(
	import.meta.dirname,
	"..",
	"fixtures",
	"config",
	"collections",
);
const ENV = { WEBDAV_APP_PASSWORD: "x" };

function envFor(file: string): NodeJS.ProcessEnv {
	return { CONFIG_FILE: join(FIXTURES, file), ...ENV };
}

function failure(file: string): ConfigError {
	try {
		loadConfig(envFor(file));
	} catch (error) {
		if (error instanceof ConfigError) return error;
		throw error;
	}
	return expect.fail("expected loadConfig to throw a ConfigError");
}

function has(issues: readonly ConfigIssue[], code: string, at: string) {
	return issues.some((issue) => issue.code === code && issue.at === at);
}

describe("collections in valid.yaml", () => {
	it("loads a schema from a sibling file", () => {
		const config = loadConfig(envFor("valid.yaml"));
		const expected = JSON.parse(
			readFileSync(join(FIXTURES, "contact.schema.json"), "utf8"),
		);
		expect(config.collections.contact?.schema).toEqual(expected);
		expect(config.collections.contact?.operations).toEqual({
			create: "anonymous",
			get: "apiKey",
		});
		expect(config.apiKeys.map((key) => key.name)).toEqual(["backend"]);
	});
});

describe("a $ref file that does not parse", () => {
	it("gives SCHEMA_REF_INVALID without the parser's message", () => {
		const dir = mkdtempSync(join(tmpdir(), "snook-ref-"));
		try {
			writeFileSync(join(dir, "bad.json"), '{ "canary-7f3a":\n');
			const text = readFileSync(join(FIXTURES, "valid.yaml"), "utf8").replace(
				"contact.schema.json",
				"bad.json",
			);
			writeFileSync(join(dir, "config.yaml"), text);
			let error: unknown;
			try {
				loadConfig({ CONFIG_FILE: join(dir, "config.yaml"), ...ENV });
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(ConfigError);
			const issues = (error as ConfigError).issues;
			expect(
				has(
					issues,
					"collection.SCHEMA_REF_INVALID",
					"/collections/contact/schema",
				),
			).toBe(true);
			expect(JSON.stringify(issues)).not.toMatch(/canary-7f3a/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("collections and apiKeys in invalid-many.yaml", () => {
	const issues = () => failure("invalid-many.yaml").issues;

	it("reports at least 18 issues in one ConfigError", () => {
		expect(issues().length).toBeGreaterThanOrEqual(18);
	});

	it("reports a reserved collection name", () => {
		expect(
			has(issues(), "collection.RESERVED_NAME", "/collections/files"),
		).toBe(true);
	});

	it("reports a badly formed collection name, an unknown operation and an unknown policy", () => {
		expect(
			has(issues(), "schema.additionalProperties", "/collections/Bad_Name"),
		).toBe(true);
		expect(
			has(
				issues(),
				"schema.additionalProperties",
				"/collections/contact/operations/publish",
			),
		).toBe(true);
		expect(
			has(issues(), "schema.enum", "/collections/contact/operations/get"),
		).toBe(true);
	});

	it("reports grants that name an unknown collection or operation, and malformed grants", () => {
		expect(has(issues(), "apiKey.UNKNOWN_GRANT", "/apiKeys/0/grants/0")).toBe(
			true,
		);
		expect(has(issues(), "apiKey.UNKNOWN_GRANT", "/apiKeys/0/grants/1")).toBe(
			true,
		);
		expect(has(issues(), "apiKey.INVALID_GRANT", "/apiKeys/0/grants/2")).toBe(
			true,
		);
		expect(has(issues(), "apiKey.INVALID_GRANT", "/apiKeys/0/grants/3")).toBe(
			true,
		);
	});

	it("reports duplicate key hashes and names, and a malformed hash without echoing it", () => {
		expect(has(issues(), "apiKey.DUPLICATE_HASH", "/apiKeys/1/hash")).toBe(
			true,
		);
		expect(has(issues(), "apiKey.DUPLICATE_NAME", "/apiKeys/1/name")).toBe(
			true,
		);
		expect(has(issues(), "schema.pattern", "/apiKeys/2/hash")).toBe(true);
	});

	it("reports schemas that strict Ajv cannot compile", () => {
		expect(
			has(
				issues(),
				"collection.SCHEMA_INVALID",
				"/collections/broken-type/schema",
			),
		).toBe(true);
		expect(
			has(
				issues(),
				"collection.SCHEMA_INVALID",
				"/collections/unknown-keyword/schema",
			),
		).toBe(true);
	});

	it("reports open object schemas at the schema location", () => {
		expect(
			has(issues(), "collection.NOT_CLOSED", "/collections/contact/schema"),
		).toBe(true);
		expect(
			has(
				issues(),
				"collection.NOT_CLOSED",
				"/collections/contact/schema/properties/address",
			),
		).toBe(true);
		expect(
			has(issues(), "collection.NOT_OBJECT", "/collections/not-object/schema"),
		).toBe(true);
	});

	it("reports reserved and unsafe property names", () => {
		const base = "/collections/contact/schema/properties";
		for (const name of ["id", "createdAt", "updatedAt"]) {
			expect(
				has(issues(), "collection.RESERVED_PROPERTY", `${base}/${name}`),
			).toBe(true);
		}
		for (const name of ["a.b", "$x", "_y"]) {
			expect(
				has(issues(), "collection.INVALID_PROPERTY_NAME", `${base}/${name}`),
			).toBe(true);
		}
	});

	it("reports $ref files outside the config directory, missing or unparsable", () => {
		expect(
			has(
				issues(),
				"collection.SCHEMA_REF_OUTSIDE",
				"/collections/ref-up/schema",
			),
		).toBe(true);
		expect(
			has(
				issues(),
				"collection.SCHEMA_REF_OUTSIDE",
				"/collections/ref-absolute/schema",
			),
		).toBe(true);
		expect(
			has(
				issues(),
				"collection.SCHEMA_REF_UNREADABLE",
				"/collections/ref-missing/schema",
			),
		).toBe(true);
		expect(
			has(
				issues(),
				"collection.SCHEMA_REF_INVALID",
				"/collections/ref-broken/schema",
			),
		).toBe(true);
	});

	it("never carries a config value", () => {
		const error = failure("invalid-many.yaml");
		expect(JSON.stringify(error.issues) + error.message).not.toMatch(
			/canary-7f3a|dav\.example\.invalid|user@example|aaaaaaaa/i,
		);
	});

	it("gives byte-identical issue lists on two runs", () => {
		expect(JSON.stringify(failure("invalid-many.yaml").issues)).toBe(
			JSON.stringify(failure("invalid-many.yaml").issues),
		);
	});
});
