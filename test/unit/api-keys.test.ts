import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const { timingSafeEqual } = await import("node:crypto");
const { ConfigKeyStore, hashKey, KEY_PREFIX } = await import(
	"../../src/auth/api-keys.ts"
);
const { generateKey } = await import("../../src/keygen.ts");

const KEY_PATTERN = /^mdra_[A-Za-z0-9_-]{43}$/;

describe("generateKey and hashKey", () => {
	it("makes a prefixed key holding 32 random bytes", () => {
		const key = generateKey();
		expect(key).toMatch(KEY_PATTERN);
		expect(key.startsWith(KEY_PREFIX)).toBe(true);
		expect(Buffer.from(key.slice(KEY_PREFIX.length), "base64url")).toHaveLength(
			32,
		);
		expect(generateKey()).not.toBe(key);
	});

	it("hashes the whole key, prefix included, to 64 lowercase hex characters", () => {
		const key = generateKey();
		expect(hashKey(key)).toMatch(/^[0-9a-f]{64}$/);
		expect(hashKey(key)).toBe(createHash("sha256").update(key).digest("hex"));
	});
});

describe("ConfigKeyStore", () => {
	const one = generateKey();
	const two = generateKey();
	const store = new ConfigKeyStore([
		{ name: "one", hash: hashKey(one), grants: ["a:get"] },
		{ name: "two", hash: hashKey(two), grants: ["b:create"] },
	]);

	it("resolves the right key name and grants for each configured key", async () => {
		expect((await store.resolve(one))?.name).toBe("one");
		expect((await store.resolve(two))?.name).toBe("two");
		expect([...((await store.resolve(two))?.grants ?? [])]).toEqual([
			"b:create",
		]);
	});

	it("returns null for a wrong key of the right shape", async () => {
		expect(await store.resolve(generateKey())).toBeNull();
	});

	it("returns null for a key of the wrong length or without the prefix", async () => {
		expect(await store.resolve(`${one}A`)).toBeNull();
		expect(await store.resolve(one.slice(0, -1))).toBeNull();
		expect(
			await store.resolve(
				randomBytes(32).toString("base64url").padEnd(48, "A"),
			),
		).toBeNull();
		expect(await store.resolve("")).toBeNull();
	});

	it("compares every configured hash even when the first one matches", async () => {
		const spy = vi.mocked(timingSafeEqual);
		spy.mockClear();
		expect((await store.resolve(one))?.name).toBe("one");
		expect(spy).toHaveBeenCalledTimes(2);
	});
});

describe("pnpm keygen", () => {
	it("prints exactly two lines, key then its hash", () => {
		const out = execFileSync(
			process.execPath,
			[join(import.meta.dirname, "..", "..", "src", "keygen.ts")],
			{ encoding: "utf8" },
		);
		const lines = out.trimEnd().split("\n");
		expect(lines).toHaveLength(2);
		const key = /^key: (mdra_[A-Za-z0-9_-]{43})$/.exec(lines[0] ?? "")?.[1];
		expect(key).toBeDefined();
		expect(lines[1]).toBe(`hash: ${hashKey(key ?? "")}`);
	});
});
