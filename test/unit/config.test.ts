import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ConfigError,
	type ConfigIssue,
	loadConfig,
} from "../../src/config/load.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "config");

function failure(env: NodeJS.ProcessEnv): ConfigError {
	try {
		loadConfig(env);
	} catch (error) {
		if (error instanceof ConfigError) return error;
		throw error;
	}
	return expect.fail("expected loadConfig to throw a ConfigError");
}

function has(issues: readonly ConfigIssue[], code: string, at?: string) {
	return issues.some(
		(issue) => issue.code === code && (at === undefined || issue.at === at),
	);
}

describe("loadConfig: one failure for a bad config file", () => {
	const invalidMany = () =>
		failure({ CONFIG_FILE: join(FIXTURES, "invalid-many.yaml") });

	it("reports an unknown top-level key", () => {
		expect(
			has(invalidMany().issues, "schema.additionalProperties", "/extra"),
		).toBe(true);
	});

	it("reports a mount name outside the allowed pattern", () => {
		expect(
			has(
				invalidMany().issues,
				"schema.additionalProperties",
				"/mounts/Bad_Name",
			),
		).toBe(true);
	});

	it("reports a missing required block by name", () => {
		expect(has(invalidMany().issues, "schema.required", "/mongo")).toBe(true);
	});

	it("reports an insecure WebDAV URL", () => {
		expect(
			has(invalidMany().issues, "storage.INSECURE_URL", "/storage/webdav/url"),
		).toBe(true);
	});

	it("never echoes a config value", () => {
		const error = invalidMany();
		expect(JSON.stringify(error.issues) + error.message).not.toMatch(
			/canary-7f3a|dav\.example\.invalid|user@example/i,
		);
	});
});
