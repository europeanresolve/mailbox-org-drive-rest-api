import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../../src/config/load.ts";
import { findResidue } from "../helpers/synthetic-residue.ts";

const EXAMPLE = "config/config.example.yaml";

// Every ${NAME} placeholder in the example, with a synthetic value.
const ENV = {
	CONFIG_FILE: EXAMPLE,
	WEBDAV_URL: "https://dav.example.invalid/",
	WEBDAV_USERNAME: "user@example.invalid",
	WEBDAV_APP_PASSWORD: "synthetic-password",
	MONGO_URI: "mongodb://127.0.0.1:27017/example",
};

const text = readFileSync(EXAMPLE, "utf8");

describe("config/config.example.yaml", () => {
	it("loads without errors when its env placeholders are set", () => {
		const config = loadConfig(ENV);
		expect(Object.keys(config.collections).length).toBeGreaterThan(0);
		expect(config.apiKeys.length).toBeGreaterThan(0);
		// docs and trustProxy are shown commented out: the defaults hold.
		expect(config.server.docs).toBe(false);
		expect(config.server.trustProxy).toEqual([]);
	});

	it("has one collection that uses every collection key", () => {
		const document = parse(text) as {
			collections: Record<string, Record<string, unknown>>;
		};
		const used = Object.values(document.collections).find((collection) =>
			[
				"schema",
				"operations",
				"indexes",
				"honeypot",
				"cors",
				"rateLimit",
				"bodyLimit",
			].every((key) => key in collection),
		);
		expect(used).toBeDefined();
	});

	it("shows an API key entry whose grants name the example collection", () => {
		const config = loadConfig(ENV);
		const key = config.apiKeys.find(
			(entry) => entry.name === "website-backend",
		);
		expect(key).toBeDefined();
		expect(key?.grants.every((grant) => grant.startsWith("contact:"))).toBe(
			true,
		);
	});

	it("uses the placeholder hash of 64 zeros and points to pnpm keygen", () => {
		const config = loadConfig(ENV);
		expect(config.apiKeys[0]?.hash).toBe("0".repeat(64));
		expect(text).toContain("pnpm keygen");
	});

	it("shows trustProxy, docs and the $ref alternative as comments", () => {
		expect(text).toMatch(/^#\s+trustProxy:/m);
		expect(text).toMatch(/^#\s+docs: true/m);
		expect(text).toContain("contact.schema.json");
	});

	it("holds only synthetic data", () => {
		expect(findResidue(EXAMPLE, text)).toEqual([]);
		for (const match of text.matchAll(/@([A-Za-z0-9.-]+)/g)) {
			expect(["example.org", "example.invalid", "example.com"]).toContain(
				match[1],
			);
		}
	});
});
