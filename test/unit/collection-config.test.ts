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

const CLOSED_OBJECT = {
	type: "object",
	additionalProperties: false,
	properties: { n: { type: "string", maxLength: 50 } },
};

function yamlLines(
	collections: Record<string, unknown>,
	apiKeys?: unknown[],
): string[] {
	const lines = [
			"mongo:",
			"  uri: mongodb://127.0.0.1:27017/nested",
			"storage:",
			"  webdav:",
			"    url: https://dav.example.invalid/",
			"    username: user@example.invalid",
			"    password: ${WEBDAV_APP_PASSWORD}",
			"mounts:",
			"  forms:",
			"    path: /forms",
			"    mode: read-write",
			"mirror:",
			"  mount: forms",
			"collections:",
		];
	for (const [name, entry] of Object.entries(collections)) {
		lines.push(`  ${JSON.stringify(name)}:`);
		const schema = (entry as { schema?: Record<string, unknown> }).schema;
		if (schema) {
			lines.push(`    schema: ${JSON.stringify(schema)}`);
		} else {
			lines.push("    schema:");
			lines.push("      type: object");
			lines.push("      additionalProperties: false");
			lines.push("      properties:");
			lines.push("        n:");
			lines.push("          type: string");
			lines.push("          maxLength: 50");
		}
		const ops = (entry as { operations?: Record<string, string> }).operations;
		if (ops) {
			lines.push("    operations:");
			for (const [op, policy] of Object.entries(ops)) {
				lines.push(`      ${op}: ${policy}`);
			}
		}
	}
	if (apiKeys) {
		lines.push("apiKeys:");
		for (const key of apiKeys as {
			name: string;
			hash: string;
			grants: string[];
		}[]) {
			lines.push(`  - name: ${key.name}`);
			lines.push(`    hash: "${key.hash}"`);
			lines.push("    grants:");
			for (const grant of key.grants) {
				lines.push(`      - ${grant}`);
			}
		}
	}
	return lines;
}

function loadNestedYaml(
	collections: Record<string, unknown>,
	apiKeys?: unknown[],
) {
	const dir = mkdtempSync(join(tmpdir(), "snook-nested-cfg-"));
	try {
		const file = join(dir, "config.yaml");
		writeFileSync(file, `${yamlLines(collections, apiKeys).join("\n")}\n`);
		return loadConfig({ CONFIG_FILE: file, ...ENV });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function nestedFailure(
	collections: Record<string, unknown>,
	apiKeys?: unknown[],
): ConfigError {
	const dir = mkdtempSync(join(tmpdir(), "snook-nested-cfg-"));
	try {
		const file = join(dir, "config.yaml");
		writeFileSync(file, `${yamlLines(collections, apiKeys).join("\n")}\n`);
		try {
			loadConfig({ CONFIG_FILE: file, ...ENV });
		} catch (error) {
			if (error instanceof ConfigError) return error;
			throw error;
		}
		return expect.fail("expected loadConfig to throw");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("nested collection names (03-06)", () => {
	const HASH =
		"0000000000000000000000000000000000000000000000000000000000000000";
	const baseOps = { create: "anonymous", get: "apiKey", list: "apiKey" };

	it("loads slash-separated collection names with nested grants", () => {
		const config = loadNestedYaml(
			{
				events: { operations: baseOps },
				"events/2026": { operations: baseOps },
				"events/2026/signups": { operations: baseOps },
			},
			[
				{
					name: "k",
					hash: HASH,
					grants: ["events/2026/signups:create", "events:get"],
				},
			],
		);
		expect(Object.keys(config.collections).sort()).toEqual([
			"events",
			"events/2026",
			"events/2026/signups",
		]);
	});

	for (const name of [
		"events//x",
		"events/",
		"/events",
		"Events/x",
		"events/X",
		`events/${"a".repeat(33)}`,
	]) {
		it(`rejects invalid collection name ${JSON.stringify(name)} at schema stage`, () => {
			const error = nestedFailure({ [name]: { operations: baseOps } });
			expect(
				error.issues.some(
					(i) =>
						i.code === "schema.additionalProperties" &&
						i.at === `/collections/${name}`,
				),
			).toBe(true);
			expect(JSON.stringify(error.issues)).not.toContain(name);
		});
	}

	it("rejects files/x as reserved on the first segment only", () => {
		const error = nestedFailure({ "files/x": { operations: baseOps } });
		expect(
			has(error.issues, "collection.RESERVED_NAME", "/collections/files/x"),
		).toBe(true);
	});

	it("accepts x/files and x/mirror", () => {
		expect(() =>
			loadNestedYaml({
				"x/files": { operations: baseOps },
				"x/mirror": { operations: baseOps },
			}),
		).not.toThrow();
	});

	it("reports unknown grant for an unconfigured nested collection", () => {
		const error = nestedFailure(
			{ events: { operations: baseOps } },
			[{ name: "k", hash: HASH, grants: ["events/2027:create"] }],
		);
		expect(
			has(error.issues, "apiKey.UNKNOWN_GRANT", "/apiKeys/0/grants/0"),
		).toBe(true);
	});

	const unsafeProps: [string, Record<string, unknown>][] = [
		["a(b)", CLOSED_OBJECT],
		[
			"nested-object",
			{
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "string", maxLength: 1 },
					"a[0]": { type: "string", maxLength: 1 },
				},
			},
		],
		[
			"nested-array",
			{
				type: "object",
				additionalProperties: false,
				properties: {
					tags: {
						type: "array",
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								"a:b": { type: "string", maxLength: 1 },
							},
						},
					},
				},
			},
		],
	];

	function mirrorUnsafeIssues(
		collections: Record<string, unknown>,
	): readonly ConfigIssue[] {
		try {
			loadNestedYaml(collections);
			return [];
		} catch (error) {
			if (error instanceof ConfigError) return error.issues;
			throw error;
		}
	}

	for (const [label, schema] of unsafeProps) {
		it(`reports MIRROR_UNSAFE_PROPERTY_NAME for ${label}`, () => {
			expect(
				mirrorUnsafeIssues({ contact: { schema, operations: baseOps } }).some(
					(i) => i.code === "collection.MIRROR_UNSAFE_PROPERTY_NAME",
				),
			).toBe(true);
		});
	}

	for (const name of ["a(b)", "a[0]", "a:b", "a/b", "a\\b", "a?", "a*", "it's"]) {
		it(`rejects mirror-unsafe root property ${name}`, () => {
			const schema = {
				type: "object",
				additionalProperties: false,
				properties: { [name]: { type: "string", maxLength: 1 } },
			};
			expect(
				has(
					mirrorUnsafeIssues({ c: { schema, operations: baseOps } }),
					"collection.MIRROR_UNSAFE_PROPERTY_NAME",
					`/collections/c/schema/properties/${name}`,
				),
			).toBe(true);
		});
	}

	it("accepts a-b and a_b property names", () => {
		const schema = {
			type: "object",
			additionalProperties: false,
			properties: {
				"a-b": { type: "string", maxLength: 1 },
				a_b: { type: "string", maxLength: 1 },
			},
		};
		expect(() =>
			loadNestedYaml({ ok: { schema, operations: baseOps } }),
		).not.toThrow();
	});
});
