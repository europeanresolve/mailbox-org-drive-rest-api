import { describe, expect, it } from "vitest";
import { applyMergePatch } from "../../src/collections/merge-patch.ts";

// Results are compared as JSON text: TAP failure output must stay on one line to count as RED evidence.
const merged = (target: unknown, patch: unknown): string =>
	JSON.stringify(applyMergePatch(target, patch));
const json = (value: unknown): string => JSON.stringify(value);

describe("applyMergePatch: RFC 7396 appendix A", () => {
	it("replaces a member", () => {
		expect(merged({ a: "b" }, { a: "c" })).toBe(json({ a: "c" }));
	});

	it("adds a member", () => {
		expect(merged({ a: "b" }, { b: "c" })).toBe(json({ a: "b", b: "c" }));
	});

	it("removes a member with null", () => {
		expect(merged({ a: "b" }, { a: null })).toBe(json({}));
		expect(merged({ a: "b", b: "c" }, { a: null })).toBe(json({ b: "c" }));
	});

	it("replaces an array with a scalar and the other way round", () => {
		expect(merged({ a: ["b"] }, { a: "c" })).toBe(json({ a: "c" }));
		expect(merged({ a: "c" }, { a: ["b"] })).toBe(json({ a: ["b"] }));
	});

	it("merges nested objects and removes nested members", () => {
		expect(merged({ a: { b: "c" } }, { a: { b: "d", c: null } })).toBe(
			json({ a: { b: "d" } }),
		);
	});

	it("replaces an array of objects as a whole", () => {
		expect(merged({ a: [{ b: "c" }] }, { a: [1] })).toBe(json({ a: [1] }));
	});

	it("merges an object over a scalar into a fresh object without nulls", () => {
		expect(merged({ a: "x" }, { a: { b: "c", d: null } })).toBe(
			json({ a: { b: "c" } }),
		);
	});

	it("keeps a null inside an array element, since arrays replace as a whole", () => {
		expect(merged({}, { a: [{ b: null }] })).toBe(json({ a: [{ b: null }] }));
	});

	it("passes through a patch that is not an object", () => {
		expect(merged({ a: "b" }, ["c"])).toBe(json(["c"]));
		expect(merged({ a: "b" }, "x")).toBe(json("x"));
		expect(merged({ a: "b" }, null)).toBe(json(null));
	});

	it("an empty patch leaves the content unchanged", () => {
		expect(merged({ a: { b: 1 } }, {})).toBe(json({ a: { b: 1 } }));
	});
});

describe("applyMergePatch: purity and safety", () => {
	it("does not mutate the target or the patch", () => {
		const target = { a: { b: "c", d: 1 }, list: [1, 2] };
		const patch = { a: { b: null, e: { f: 1 } }, list: [3] };
		const targetBefore = json(target);
		const patchBefore = json(patch);
		const result = applyMergePatch(target, patch);
		expect(json(target)).toBe(targetBefore);
		expect(json(patch)).toBe(patchBefore);
		expect(result === target).toBe(false);
	});

	it("returns a new object even for an empty patch", () => {
		const target = { a: 1 };
		expect(applyMergePatch(target, {}) === target).toBe(false);
	});

	it("keeps a __proto__ member as plain data and never touches Object.prototype", () => {
		const patch = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
		const result = applyMergePatch({}, patch) as Record<string, unknown>;
		expect(typeof ({} as Record<string, unknown>).polluted).toBe("undefined");
		expect(Object.getPrototypeOf(result) === Object.prototype).toBe(true);
		expect(Object.keys(result).sort().join(",")).toBe("__proto__,a");
	});
});
