import { describe, expect, it } from "vitest";
import { StorageError } from "../../src/storage/errors.ts";
import {
	buildMounts,
	type MountIssue,
	type Mounts,
} from "../../src/storage/mounts.ts";

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

function issuesOf(defs: Parameters<typeof buildMounts>[0]): MountIssue[] {
	const built = buildMounts(defs);
	if (built.ok) throw new Error("expected buildMounts to report issues");
	return built.issues;
}

describe("buildMounts validation (STOR-02)", () => {
	it("rejects a name outside ^[a-z][a-z0-9-]{0,31}$", () => {
		expect(issuesOf({ Bad_Name: { path: "/a", mode: "read" } })).toEqual([
			{ code: "mount.INVALID_NAME", at: "/mounts/Bad_Name" },
		]);
		expect(issuesOf({ "1abc": { path: "/a", mode: "read" } })[0]?.code).toBe(
			"mount.INVALID_NAME",
		);
		expect(
			issuesOf({ [`a${"b".repeat(32)}`]: { path: "/a", mode: "read" } })[0]
				?.code,
		).toBe("mount.INVALID_NAME");
	});

	it("accepts a 32-character name", () => {
		const name = `a${"b".repeat(31)}`;
		expect(buildMounts({ [name]: { path: "/a", mode: "read" } }).ok).toBe(true);
	});

	it("reports the Drive root as mount.AT_ROOT", () => {
		expect(issuesOf({ r: { path: "/", mode: "read" } })).toEqual([
			{ code: "mount.AT_ROOT", at: "/mounts/r" },
		]);
	});

	it("reports a root without a leading slash as mount.INVALID_PATH", () => {
		expect(issuesOf({ r: { path: "relative/path", mode: "read" } })).toEqual([
			{ code: "mount.INVALID_PATH", at: "/mounts/r" },
		]);
	});

	it("reports a root with a dot segment as mount.INVALID_PATH", () => {
		expect(issuesOf({ r: { path: "/a/../b", mode: "read" } })).toEqual([
			{ code: "mount.INVALID_PATH", at: "/mounts/r" },
		]);
	});

	it("reports read-write /a with read /a/b as mount.OVERLAP in config order", () => {
		expect(
			issuesOf({
				x: { path: "/a", mode: "read-write" },
				y: { path: "/a/b", mode: "read" },
			}),
		).toEqual([{ code: "mount.OVERLAP", at: "/mounts/x /mounts/y" }]);
	});

	it("reports the overlap when the nested mount is the read-write one", () => {
		expect(
			issuesOf({
				x: { path: "/a/b", mode: "read" },
				y: { path: "/a", mode: "read-write" },
			}),
		).toEqual([{ code: "mount.OVERLAP", at: "/mounts/x /mounts/y" }]);
	});

	it("allows nested read mounts", () => {
		expect(
			buildMounts({
				x: { path: "/a", mode: "read" },
				y: { path: "/a/b", mode: "read" },
			}).ok,
		).toBe(true);
	});

	it("compares whole segments, so /a and /ab do not overlap", () => {
		expect(
			buildMounts({
				x: { path: "/a", mode: "read-write" },
				y: { path: "/ab", mode: "read-write" },
			}).ok,
		).toBe(true);
	});

	it("treats equal roots as an overlap when either is read-write", () => {
		expect(
			issuesOf({
				x: { path: "/a", mode: "read-write" },
				y: { path: "/a/", mode: "read" },
			}),
		).toEqual([{ code: "mount.OVERLAP", at: "/mounts/x /mounts/y" }]);
	});

	it("allows equal roots when both mounts are read", () => {
		expect(
			buildMounts({
				x: { path: "/a", mode: "read" },
				y: { path: "/a", mode: "read" },
			}).ok,
		).toBe(true);
	});

	it("treats NFD and NFC spellings of a root as equal for overlap", () => {
		expect(
			issuesOf({
				x: { path: "/Mu\u0308ller", mode: "read-write" },
				y: { path: "/M\u00fcller", mode: "read" },
			}),
		).toEqual([{ code: "mount.OVERLAP", at: "/mounts/x /mounts/y" }]);
	});

	it("returns every issue in config order and each pair once", () => {
		expect(
			issuesOf({
				x: { path: "/a", mode: "read-write" },
				Bad_Name: { path: "/c", mode: "read" },
				y: { path: "/a/b", mode: "read" },
				z: { path: "/", mode: "read" },
			}),
		).toEqual([
			{ code: "mount.INVALID_NAME", at: "/mounts/Bad_Name" },
			{ code: "mount.AT_ROOT", at: "/mounts/z" },
			{ code: "mount.OVERLAP", at: "/mounts/x /mounts/y" },
		]);
	});

	it("keeps mount names in config order", () => {
		const built = buildMounts({
			b: { path: "/b", mode: "read" },
			a: { path: "/a", mode: "read" },
		});
		if (!built.ok) throw new Error("expected ok");
		expect(built.mounts.names()).toEqual(["b", "a"]);
		expect(built.mounts.get("a").mode).toBe("read");
	});

	it("never puts a path into an issue", () => {
		const text = JSON.stringify(
			issuesOf({
				x: { path: "/Secret Person/a", mode: "read-write" },
				y: { path: "/Secret Person/a/b", mode: "read" },
			}),
		);
		expect(text).not.toContain("Secret Person");
	});
});
