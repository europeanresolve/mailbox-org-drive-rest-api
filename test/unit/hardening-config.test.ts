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
				mirror: { mount: "live" },
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

describe("server.trustProxy", () => {
	it("loads IPs and CIDRs of both families", () => {
		const config = load(
			{},
			{ trustProxy: ["10.0.0.0/8", "192.0.2.1", "2001:db8::/32"] },
		);
		expect(config.server.trustProxy).toEqual([
			"10.0.0.0/8",
			"192.0.2.1",
			"2001:db8::/32",
		]);
	});

	it("is an empty list when absent", () => {
		expect(load().server.trustProxy).toEqual([]);
	});

	it("rejects a bad prefix, a non-address and an empty prefix at the entry's index", () => {
		const found = codes(
			issuesOf(() =>
				load({}, { trustProxy: ["10.0.0.0/33", "not-an-ip", "10.0.0.1/"] }),
			),
		);
		expect(found).toEqual([
			"server.INVALID_TRUST_PROXY /server/trustProxy/0",
			"server.INVALID_TRUST_PROXY /server/trustProxy/1",
			"server.INVALID_TRUST_PROXY /server/trustProxy/2",
		]);
	});

	it("rejects an IPv6 prefix above 128, a signed prefix and the boolean form", () => {
		const found = codes(
			issuesOf(() =>
				load({}, { trustProxy: ["2001:db8::/129", "10.0.0.0/-1", "true"] }),
			),
		);
		expect(found).toHaveLength(3);
		expect(
			found.every((entry) => entry.startsWith("server.INVALID_TRUST_PROXY")),
		).toBe(true);
	});

	it("never carries the rejected value in an issue", () => {
		const issues = issuesOf(() =>
			load({}, { trustProxy: ["CANARY-7f3a@example.invalid"] }),
		);
		expect(JSON.stringify(issues)).not.toContain("CANARY");
	});
});

describe("collections.<name>.rateLimit", () => {
	it("defaults to 10 requests per 60 seconds", () => {
		expect(load().collections.contact?.rateLimit).toEqual({
			max: 10,
			windowSeconds: 60,
		});
	});

	it("fills only the missing half", () => {
		expect(
			load({ rateLimit: { max: 3 } }).collections.contact?.rateLimit,
		).toEqual({
			max: 3,
			windowSeconds: 60,
		});
		expect(
			load({ rateLimit: { windowSeconds: 5 } }).collections.contact?.rateLimit,
		).toEqual({ max: 10, windowSeconds: 5 });
	});

	it("rejects zero for either number", () => {
		expect(codes(issuesOf(() => load({ rateLimit: { max: 0 } })))).toEqual([
			"schema.minimum /collections/contact/rateLimit/max",
		]);
		expect(
			codes(issuesOf(() => load({ rateLimit: { windowSeconds: 0 } }))),
		).toEqual(["schema.minimum /collections/contact/rateLimit/windowSeconds"]);
	});

	it("rejects an unknown key and a fractional number", () => {
		const found = codes(
			issuesOf(() => load({ rateLimit: { max: 1.5, burst: 3 } })),
		);
		expect(found).toContain("schema.type /collections/contact/rateLimit/max");
		expect(found).toContain(
			"schema.additionalProperties /collections/contact/rateLimit/burst",
		);
	});
});
