import { describe, expect, it } from "vitest";
import {
	canonicalHash,
	entryId,
	parseIdempotencyKey,
} from "../../src/collections/idempotency.ts";

describe("canonicalHash", () => {
	it("ignores object key order, at every depth", () => {
		expect(canonicalHash({ a: 1, b: { d: 2, c: 3 } })).toBe(
			canonicalHash({ b: { c: 3, d: 2 }, a: 1 }),
		);
	});

	it("is a SHA-256 hex digest", () => {
		expect(canonicalHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
	});

	it("keeps array order", () => {
		expect(canonicalHash([1, 2])).not.toBe(canonicalHash([2, 1]));
		expect(canonicalHash({ list: [{ b: 1, a: 2 }] })).toBe(
			canonicalHash({ list: [{ a: 2, b: 1 }] }),
		);
	});

	it("tells a number from a string and null from absent", () => {
		expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: "1" }));
		expect(canonicalHash({ a: null })).not.toBe(canonicalHash({}));
	});
});

describe("entryId", () => {
	it("is a SHA-256 hex digest that depends on collection and key", () => {
		expect(entryId("contact", "k1")).toMatch(/^[0-9a-f]{64}$/);
		expect(entryId("contact", "k1")).not.toBe(entryId("staff", "k1"));
		expect(entryId("contact", "k1")).not.toBe(entryId("contact", "k2"));
	});

	it("does not contain the raw key", () => {
		expect(entryId("contact", "order-123")).not.toContain("order-123");
	});

	it("cannot be forged by moving the boundary between collection and key", () => {
		expect(entryId("ab", "c")).not.toBe(entryId("a", "bc"));
	});
});

describe("parseIdempotencyKey", () => {
	it("accepts visible ASCII of 1 to 255 characters", () => {
		expect(parseIdempotencyKey("a")).toBe("a");
		expect(parseIdempotencyKey("order-123_X.y")).toBe("order-123_X.y");
		expect(parseIdempotencyKey("k".repeat(255))).toBe("k".repeat(255));
		expect(parseIdempotencyKey("!~")).toBe("!~");
	});

	it.each([
		["empty", ""],
		["256 characters", "k".repeat(256)],
		["a space", "a b"],
		["a tab", "a\tb"],
		["a control character", "a\u0001b"],
		["a non-ASCII character", "schlüssel"],
		["a repeated header", ["k1", "k2"]],
		["a non-string", 42],
		["undefined", undefined],
	])("rejects %s", (_label, value) => {
		expect(parseIdempotencyKey(value)).toBeNull();
	});
});
