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

const SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: { email: { type: "string", maxLength: 254 } },
};

/** A minimal valid document with the given server block and one collection. */
function load(
	collection: Record<string, unknown> = {},
	server?: Record<string, unknown>,
) {
	const dir = mkdtempSync(join(tmpdir(), "snook-hardening-"));
	try {
		const file = join(dir, "config.yaml");
		writeFileSync(
			file,
			stringify({
				...(server ? { server } : {}),
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
						schema: SCHEMA,
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

describe("collections.<name>.cors.origins", () => {
	it("accepts canonical http and https origins", () => {
		const config = load({
			cors: {
				origins: [
					"https://www.example.org",
					"http://localhost:3000",
					"https://example.org:8443",
				],
			},
		});
		expect(config.collections.contact?.cors?.origins).toEqual([
			"https://www.example.org",
			"http://localhost:3000",
			"https://example.org:8443",
		]);
	});

	it("rejects a trailing slash, upper case, a default port, a scheme, a path and a wildcard", () => {
		const origins = [
			"https://www.example.org/",
			"https://WWW.example.org",
			"https://www.example.org:443",
			"ftp://x.example",
			"https://x.example/path",
			"*",
		];
		const found = codes(issuesOf(() => load({ cors: { origins } })));
		expect(found).toEqual(
			origins.map(
				(_, i) =>
					`collection.INVALID_ORIGIN /collections/contact/cors/origins/${i}`,
			),
		);
	});

	it("never carries the rejected value in an issue", () => {
		const issues = issuesOf(() =>
			load({ cors: { origins: ["https://CANARY-7f3a.example.invalid/"] } }),
		);
		expect(JSON.stringify(issues)).not.toContain("CANARY");
	});
});
