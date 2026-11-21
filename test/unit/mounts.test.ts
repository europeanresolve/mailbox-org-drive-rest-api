import { describe, expect, it } from "vitest";
import { StorageError } from "../../src/storage/errors.ts";
import { buildMounts, type Mounts } from "../../src/storage/mounts.ts";

function formsMounts(): Mounts {
	const built = buildMounts({
		forms: { path: "/Userstore/Example Service/forms", mode: "read-write" },
	});
	if (!built.ok) throw new Error("expected buildMounts to succeed");
	return built.mounts;
}

function thrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("Mounts.resolve (tracer)", () => {
	it("buildMounts accepts a valid read-write mount", () => {
		const built = buildMounts({
			forms: { path: "/Userstore/Example Service/forms", mode: "read-write" },
		});
		expect(built.ok).toBe(true);
	});

	it("resolves a relative path inside the mount root", () => {
		const resolved = formsMounts().resolve("forms", "a/b.txt");
		expect(resolved.segments).toEqual([
			"Userstore",
			"Example Service",
			"forms",
			"a",
			"b.txt",
		]);
	});

	it("rejects a traversal with invalid-path from resolve", () => {
		const error = thrown(() => formsMounts().resolve("forms", "../x"));
		expect(error).toBeInstanceOf(StorageError);
		expect((error as StorageError).kind).toBe("invalid-path");
		expect((error as StorageError).op).toBe("resolve");
	});

	it("rejects an unknown mount with unknown-mount", () => {
		const error = thrown(() => formsMounts().resolve("nope", "a"));
		expect(error).toBeInstanceOf(StorageError);
		expect((error as StorageError).kind).toBe("unknown-mount");
	});

	it("never prints path segments through String() or JSON.stringify", () => {
		const resolved = formsMounts().resolve("forms", "a/b.txt");
		for (const text of [String(resolved), JSON.stringify(resolved)]) {
			expect(text).toContain("forms");
			expect(text).toMatch(/[0-9a-f]{8}/);
			expect(text).not.toContain("Example Service");
			expect(text).not.toContain("Userstore");
			expect(text).not.toContain("b.txt");
		}
	});
});
