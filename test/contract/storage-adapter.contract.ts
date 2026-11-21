import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import { StorageError } from "../../src/storage/errors.ts";
import type { ResolvedPath } from "../../src/storage/mounts.ts";

export type ContractSetup = () => Promise<{
	adapter: StorageAdapter;
	path: (rel: string) => ResolvedPath;
	cleanup?: () => Promise<void>;
}>;

async function rejectsWith(promise: Promise<unknown>, kind: string) {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(StorageError);
	expect((error as StorageError).kind).toBe(kind);
}

const buf = (text: string): Buffer => Buffer.from(text);

/**
 * Shared StorageAdapter contract. It asserts on StorageError kinds and
 * returned values only, never on HTTP statuses, so the in-memory and WebDAV
 * adapters stay interchangeable.
 */
export function storageAdapterContract(
	name: string,
	setup: ContractSetup,
): void {
	describe(`StorageAdapter contract: ${name}`, () => {
		let ctx: Awaited<ReturnType<ContractSetup>>;

		beforeEach(async () => {
			ctx = await setup();
		});

		afterEach(async () => {
			await ctx.cleanup?.();
		});

		it("write then read round-trips bytes and stat agrees", async () => {
			const { adapter, path } = ctx;
			const entry = await adapter.write(path("f.txt"), buf("synthetic"));
			expect(entry.kind).toBe("file");
			expect(entry.size).toBe(9);
			expect(await adapter.read(path("f.txt"))).toEqual(buf("synthetic"));
			const stat = await adapter.stat(path("f.txt"));
			expect(stat.kind).toBe("file");
			expect(stat.size).toBe(9);
		});

		describe("stat", () => {
			it("reports a folder as kind dir", async () => {
				const { adapter, path } = ctx;
				await adapter.mkdir(path("d"));
				expect((await adapter.stat(path("d"))).kind).toBe("dir");
			});

			it("reports file name, kind and size", async () => {
				const { adapter, path } = ctx;
				await adapter.write(path("f.txt"), buf("abc"));
				const entry = await adapter.stat(path("f.txt"));
				expect(entry).toMatchObject({ name: "f.txt", kind: "file", size: 3 });
			});

			it("rejects a missing path with not-found", async () => {
				const { adapter, path } = ctx;
				await rejectsWith(adapter.stat(path("missing")), "not-found");
			});
		});

		describe("list", () => {
			it("returns [] for an empty folder", async () => {
				const { adapter, path } = ctx;
				await adapter.mkdir(path("d"));
				expect(await adapter.list(path("d"))).toEqual([]);
			});

			it("sorts entries by name in code-unit order", async () => {
				const { adapter, path } = ctx;
				for (const n of ["b", "a", "B"]) {
					await adapter.write(path(n), buf("x"));
				}
				const names = (await adapter.list(path(""))).map((e) => e.name);
				expect(names).toEqual(["B", "a", "b"]);
			});

			it("excludes the folder's own entry", async () => {
				const { adapter, path } = ctx;
				await adapter.mkdir(path("d"));
				await adapter.write(path("d/inner.txt"), buf("x"));
				const entries = await adapter.list(path("d"));
				expect(entries.map((e) => e.name)).toEqual(["inner.txt"]);
			});

			it("is shallow: nested entries are not listed", async () => {
				const { adapter, path } = ctx;
				await adapter.mkdir(path("d"));
				await adapter.write(path("d/inner.txt"), buf("x"));
				const entries = await adapter.list(path(""));
				expect(entries.map((e) => [e.name, e.kind])).toEqual([["d", "dir"]]);
			});

			it("rejects a missing folder with not-found", async () => {
				const { adapter, path } = ctx;
				await rejectsWith(adapter.list(path("missing")), "not-found");
			});
		});

		describe("read", () => {
			it("rejects a missing file with not-found", async () => {
				const { adapter, path } = ctx;
				await rejectsWith(adapter.read(path("missing")), "not-found");
			});

			it("rejects a folder with conflict", async () => {
				const { adapter, path } = ctx;
				await adapter.mkdir(path("d"));
				await rejectsWith(adapter.read(path("d")), "conflict");
			});

			it("rejects a file above maxBytes with too-large", async () => {
				const { adapter, path } = ctx;
				await adapter.write(path("f.txt"), buf("synthetic"));
				await rejectsWith(
					adapter.read(path("f.txt"), { maxBytes: 4 }),
					"too-large",
				);
			});

			it("reads a file exactly at maxBytes", async () => {
				const { adapter, path } = ctx;
				await adapter.write(path("f.txt"), buf("synthetic"));
				expect(await adapter.read(path("f.txt"), { maxBytes: 9 })).toEqual(
					buf("synthetic"),
				);
			});

			it("returns an empty Buffer for a zero-byte file", async () => {
				const { adapter, path } = ctx;
				await adapter.write(path("empty"), Buffer.alloc(0));
				const body = await adapter.read(path("empty"));
				expect(Buffer.isBuffer(body)).toBe(true);
				expect(body.length).toBe(0);
			});
		});

		describe("write", () => {
			it("creates a zero-byte file from an empty Buffer", async () => {
				const { adapter, path } = ctx;
				const entry = await adapter.write(path("empty"), Buffer.alloc(0));
				expect(entry.size).toBe(0);
				expect((await adapter.stat(path("empty"))).size).toBe(0);
			});

			it("overwrites an existing file", async () => {
				const { adapter, path } = ctx;
				await adapter.write(path("f.txt"), buf("one"));
				await adapter.write(path("f.txt"), buf("second"));
				expect(await adapter.read(path("f.txt"))).toEqual(buf("second"));
			});

			it("rejects a missing parent with conflict", async () => {
				const { adapter, path } = ctx;
				await rejectsWith(
					adapter.write(path("nope/f.txt"), buf("x")),
					"conflict",
				);
			});

			it("rejects writing over a folder with conflict", async () => {
				const { adapter, path } = ctx;
				await adapter.mkdir(path("d"));
				await rejectsWith(adapter.write(path("d"), buf("x")), "conflict");
				expect((await adapter.stat(path("d"))).kind).toBe("dir");
			});

			it("accepts identical bytes twice and reads them back", async () => {
				const { adapter, path } = ctx;
				await adapter.write(path("f.txt"), buf("same"));
				await adapter.write(path("f.txt"), buf("same"));
				expect(await adapter.read(path("f.txt"))).toEqual(buf("same"));
			});

			it("keeps exactly one body after two concurrent writes", async () => {
				const { adapter, path } = ctx;
				const a = Buffer.alloc(4096, "a");
				const b = Buffer.alloc(8192, "b");
				await Promise.all([
					adapter.write(path("f.txt"), a),
					adapter.write(path("f.txt"), b),
				]);
				const body = await adapter.read(path("f.txt"));
				expect([a.equals(body), b.equals(body)].filter(Boolean)).toHaveLength(
					1,
				);
			});

			it("keeps adjacent names distinct: /a does not create /ab", async () => {
				const { adapter, path } = ctx;
				await adapter.write(path("a"), buf("x"));
				await rejectsWith(adapter.stat(path("ab")), "not-found");
			});
		});

		describe("mkdir", () => {
			it("creates a folder", async () => {
				const { adapter, path } = ctx;
				await adapter.mkdir(path("d"));
				expect((await adapter.stat(path("d"))).kind).toBe("dir");
			});

			it("rejects an existing folder with conflict", async () => {
				const { adapter, path } = ctx;
				await adapter.mkdir(path("d"));
				await rejectsWith(adapter.mkdir(path("d")), "conflict");
			});

			it("rejects a missing parent with conflict", async () => {
				const { adapter, path } = ctx;
				await rejectsWith(adapter.mkdir(path("a/b")), "conflict");
			});
		});

		describe("move", () => {
			it("renames a file: source gone, destination holds the bytes", async () => {
				const { adapter, path } = ctx;
				await adapter.write(path("from.txt"), buf("payload"));
				await adapter.move(path("from.txt"), path("to.txt"), {
					overwrite: false,
				});
				await rejectsWith(adapter.stat(path("from.txt")), "not-found");
				expect(await adapter.read(path("to.txt"))).toEqual(buf("payload"));
			});

			it("rejects a missing source with not-found", async () => {
				const { adapter, path } = ctx;
				await rejectsWith(
					adapter.move(path("missing"), path("to.txt"), { overwrite: false }),
					"not-found",
				);
			});

			it("rejects an existing destination with conflict when overwrite is false", async () => {
				const { adapter, path } = ctx;
				await adapter.write(path("from.txt"), buf("one"));
				await adapter.write(path("to.txt"), buf("two"));
				await rejectsWith(
					adapter.move(path("from.txt"), path("to.txt"), { overwrite: false }),
					"conflict",
				);
				expect(await adapter.read(path("from.txt"))).toEqual(buf("one"));
				expect(await adapter.read(path("to.txt"))).toEqual(buf("two"));
			});

			it("replaces the destination when overwrite is true", async () => {
				const { adapter, path } = ctx;
				await adapter.write(path("from.txt"), buf("one"));
				await adapter.write(path("to.txt"), buf("two"));
				await adapter.move(path("from.txt"), path("to.txt"), {
					overwrite: true,
				});
				expect(await adapter.read(path("to.txt"))).toEqual(buf("one"));
				await rejectsWith(adapter.stat(path("from.txt")), "not-found");
			});

			it("rejects move(p, p) with conflict and keeps the file", async () => {
				const { adapter, path } = ctx;
				await adapter.write(path("f.txt"), buf("keep"));
				for (const overwrite of [false, true]) {
					await rejectsWith(
						adapter.move(path("f.txt"), path("f.txt"), { overwrite }),
						"conflict",
					);
				}
				expect(await adapter.read(path("f.txt"))).toEqual(buf("keep"));
			});
		});

		describe("delete", () => {
			it("removes a file", async () => {
				const { adapter, path } = ctx;
				await adapter.write(path("f.txt"), buf("x"));
				await adapter.delete(path("f.txt"));
				await rejectsWith(adapter.stat(path("f.txt")), "not-found");
			});

			it("rejects a second delete with not-found", async () => {
				const { adapter, path } = ctx;
				await adapter.write(path("f.txt"), buf("x"));
				await adapter.delete(path("f.txt"));
				await rejectsWith(adapter.delete(path("f.txt")), "not-found");
			});

			it("rejects an empty folder with conflict", async () => {
				const { adapter, path } = ctx;
				await adapter.mkdir(path("d"));
				await rejectsWith(adapter.delete(path("d")), "conflict");
				expect((await adapter.stat(path("d"))).kind).toBe("dir");
			});

			it("rejects a non-empty folder with conflict and keeps its children", async () => {
				const { adapter, path } = ctx;
				await adapter.mkdir(path("d"));
				await adapter.write(path("d/child.txt"), buf("staff work"));
				await rejectsWith(adapter.delete(path("d")), "conflict");
				expect(await adapter.read(path("d/child.txt"))).toEqual(
					buf("staff work"),
				);
			});
		});
	});
}
