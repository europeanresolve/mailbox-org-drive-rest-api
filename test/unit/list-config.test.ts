import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import { scheduleIndexSetup } from "../../src/collections/indexes.ts";
import {
	ConfigError,
	type ConfigIssue,
	loadConfig,
} from "../../src/config/load.ts";

const SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["status", "address", "priority", "tags"],
	properties: {
		status: { type: "string", maxLength: 10 },
		nickname: { type: "string", maxLength: 10 },
		maybe: { type: ["string", "null"] },
		priority: { type: "integer" },
		sort: { type: "string", maxLength: 10 },
		gte: { type: "string", maxLength: 10 },
		tags: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: { name: { type: "string" } },
			},
		},
		address: {
			type: "object",
			additionalProperties: false,
			required: ["country"],
			properties: {
				country: { type: "string", maxLength: 2 },
				region: { type: "string", maxLength: 2 },
			},
		},
	},
};

function issuesFor(indexes: unknown): ConfigIssue[] {
	const dir = mkdtempSync(join(tmpdir(), "snook-indexes-"));
	try {
		const file = join(dir, "config.yaml");
		writeFileSync(
			file,
			stringify({
				mongo: { uri: "mongodb://127.0.0.1:27017/example" },
				storage: {
					webdav: {
						url: "https://dav.example.invalid/",
						username: "user",
						password: "x",
					},
				},
				mounts: { forms: { path: "/Forms", mode: "read-write" } },
				collections: {
					ticket: {
						schema: SCHEMA,
						operations: { create: "anonymous", list: "apiKey" },
						indexes,
					},
				},
			}),
		);
		try {
			loadConfig({ CONFIG_FILE: file });
		} catch (error) {
			if (error instanceof ConfigError) return [...error.issues];
			throw error;
		}
		return [];
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function at(i: number): string {
	return `/collections/ticket/indexes/${i}`;
}

/** The issue codes at one index pointer, joined, so a mismatch prints on one line. */
function codeAt(issues: ConfigIssue[], i: number): string {
	return issues
		.filter((issue) => issue.at === at(i))
		.map((x) => x.code)
		.join(",");
}

describe("indexes in collection config", () => {
	it("accepts dotted paths that resolve to required scalars", () => {
		expect(issuesFor(["status", "address.country", "priority"])).toEqual([]);
	});

	it("accepts a collection with no indexes key", () => {
		expect(issuesFor(undefined)).toEqual([]);
	});

	it("reports every bad path in one ConfigError at its index pointer", () => {
		const issues = issuesFor([
			"status", // 0 ok
			"nope", // 1 unknown
			"address.nope", // 2 unknown below an object
			"tags.name", // 3 through an array
			"address", // 4 object, not scalar
			"maybe", // 5 union type, not scalar
			"nickname", // 6 not required
			"address.region", // 7 not required at the second level
			"gte", // 8 operator segment
			"address.gte", // 9 operator segment below an object
			"sort", // 10 reserved
			"cursor", // 11 reserved
			"limit", // 12 reserved
			"status", // 13 duplicate
		]);
		expect(codeAt(issues, 0)).toBe("");
		expect(codeAt(issues, 1)).toBe("collection.INDEX_UNKNOWN_PATH");
		expect(codeAt(issues, 2)).toBe("collection.INDEX_UNKNOWN_PATH");
		expect(codeAt(issues, 3)).toBe("collection.INDEX_THROUGH_ARRAY");
		expect(codeAt(issues, 4)).toBe("collection.INDEX_NOT_SCALAR");
		expect(codeAt(issues, 5)).toBe("collection.INDEX_NOT_SCALAR");
		expect(codeAt(issues, 6)).toBe("collection.INDEX_OPTIONAL");
		expect(codeAt(issues, 7)).toBe("collection.INDEX_OPTIONAL");
		expect(codeAt(issues, 8)).toBe("collection.INDEX_OPERATOR_SEGMENT");
		expect(codeAt(issues, 9)).toBe("collection.INDEX_OPERATOR_SEGMENT");
		expect(codeAt(issues, 10)).toBe("collection.INDEX_RESERVED");
		expect(codeAt(issues, 11)).toBe("collection.INDEX_RESERVED");
		expect(codeAt(issues, 12)).toBe("collection.INDEX_RESERVED");
		expect(codeAt(issues, 13)).toBe("collection.INDEX_DUPLICATE");
	});

	it("never carries the path itself", () => {
		const issues = issuesFor(["canary-7f3a.x"]);
		expect(issues.length).toBeGreaterThan(0);
		expect(JSON.stringify(issues)).not.toMatch(/canary-7f3a/i);
	});
});

describe("index setup scheduling", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("retries after a failure until it succeeds, logging type and code only", async () => {
		vi.useFakeTimers();
		const ensure = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("canary-7f3a"))
			.mockResolvedValueOnce(undefined);
		const warn = vi.fn();
		scheduleIndexSetup({ ensure, log: { warn }, retryMs: 30_000 });

		await vi.advanceTimersByTimeAsync(0);
		expect(ensure).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[1]).toBe("index setup failed");
		expect(JSON.stringify(warn.mock.calls)).not.toMatch(/canary-7f3a/i);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(ensure).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(ensure).toHaveBeenCalledTimes(2);
	});

	it("stops retrying once stopped", async () => {
		vi.useFakeTimers();
		const ensure = vi
			.fn<() => Promise<void>>()
			.mockRejectedValue(new Error("down"));
		const handle = scheduleIndexSetup({
			ensure,
			log: { warn: vi.fn() },
			retryMs: 30_000,
		});
		await vi.advanceTimersByTimeAsync(0);
		handle.stop();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(ensure).toHaveBeenCalledTimes(1);
	});
});
