import { describe, expect, it } from "vitest";
import type {
	ReadOptions,
	StatEntry,
	StorageAdapter,
} from "../../src/storage/adapter.ts";
import { StorageError } from "../../src/storage/errors.ts";
import { MemoryAdapter } from "../../src/storage/memory-adapter.ts";
import {
	openMount,
	type ReadableMount,
	type WritableMount,
} from "../../src/storage/mount-view.ts";
import {
	buildMounts,
	type Mounts,
	type ResolvedPath,
} from "../../src/storage/mounts.ts";

function testMounts(): Mounts {
	const built = buildMounts({
		t: { path: "/c", mode: "read-write" },
		r: { path: "/r", mode: "read" },
	});
	if (!built.ok) throw new Error("expected buildMounts to succeed");
	return built.mounts;
}

/** Delegates to a MemoryAdapter and records every call. */
class SpyAdapter implements StorageAdapter {
	readonly calls: { op: string; args: ResolvedPath[] }[] = [];
	readonly inner = new MemoryAdapter();

	stat(p: ResolvedPath): Promise<StatEntry> {
		this.calls.push({ op: "stat", args: [p] });
		return this.inner.stat(p);
	}
	list(p: ResolvedPath): Promise<StatEntry[]> {
		this.calls.push({ op: "list", args: [p] });
		return this.inner.list(p);
	}
	read(p: ResolvedPath, opts?: ReadOptions): Promise<Buffer> {
		this.calls.push({ op: "read", args: [p] });
		return this.inner.read(p, opts);
	}
	write(p: ResolvedPath, body: Buffer): Promise<StatEntry> {
		this.calls.push({ op: "write", args: [p] });
		return this.inner.write(p, body);
	}
	mkdir(p: ResolvedPath): Promise<void> {
		this.calls.push({ op: "mkdir", args: [p] });
		return this.inner.mkdir(p);
	}
	move(
		from: ResolvedPath,
		to: ResolvedPath,
		opts: { overwrite: boolean },
	): Promise<void> {
		this.calls.push({ op: "move", args: [from, to] });
		return this.inner.move(from, to, opts);
	}
	delete(p: ResolvedPath): Promise<void> {
		this.calls.push({ op: "delete", args: [p] });
		return this.inner.delete(p);
	}
}

async function fixture() {
	const mounts = testMounts();
	const spy = new SpyAdapter();
	// Seed through the inner adapter so the spy starts with zero calls.
	await spy.inner.mkdir(mounts.resolve("t", ""));
	await spy.inner.mkdir(mounts.resolve("r", ""));
	await spy.inner.write(
		mounts.resolve("r", "doc.txt"),
		Buffer.from("synthetic"),
	);
	return { mounts, spy };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(e: unknown) => e,
	);
}

describe("MountView on a read mount", () => {
	it("returns mode read with working list, stat and read", async () => {
		const { mounts, spy } = await fixture();
		const mount = openMount(mounts, spy, "r");
		expect(mount.mode).toBe("read");
		expect((await mount.list("")).map((e) => e.name)).toEqual(["doc.txt"]);
		expect((await mount.stat("doc.txt")).size).toBe(9);
		expect(await mount.read("doc.txt")).toEqual(Buffer.from("synthetic"));
	});

	it("does not expose write methods at the type level", async () => {
		const { mounts, spy } = await fixture();
		const mount: ReadableMount | WritableMount = openMount(mounts, spy, "r");
		if (mount.mode === "read") {
			// @ts-expect-error write is absent from ReadableMount
			expect(typeof mount.write).toBe("function");
		}
	});

	it("rejects write, mkdir, move and delete with read-only-mount and never calls the adapter", async () => {
		const { mounts, spy } = await fixture();
		const mount = openMount(mounts, spy, "r") as unknown as WritableMount;
		const attempts: [string, () => Promise<unknown>][] = [
			["write", () => mount.write("new.txt", Buffer.from("x"))],
			["mkdir", () => mount.mkdir("sub")],
			["move", () => mount.move("doc.txt", "moved.txt", { overwrite: false })],
			["delete", () => mount.delete("doc.txt")],
		];
		for (const [op, attempt] of attempts) {
			const error = await rejection(attempt());
			expect(error).toBeInstanceOf(StorageError);
			expect((error as StorageError).kind).toBe("read-only-mount");
			expect((error as StorageError).op).toBe(op);
		}
		expect(spy.calls).toEqual([]);
		expect(await spy.inner.read(mounts.resolve("r", "doc.txt"))).toEqual(
			Buffer.from("synthetic"),
		);
	});
});

describe("openMount errors", () => {
	it("rejects an unknown mount name with unknown-mount", async () => {
		const { mounts, spy } = await fixture();
		let error: unknown;
		try {
			openMount(mounts, spy, "nope");
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(StorageError);
		expect((error as StorageError).kind).toBe("unknown-mount");
		expect(spy.calls).toEqual([]);
	});

	it("rejects a traversal with invalid-path before any adapter call", async () => {
		const { mounts, spy } = await fixture();
		const mount = openMount(mounts, spy, "t");
		const error = await rejection(mount.read("../x"));
		expect(error).toBeInstanceOf(StorageError);
		expect((error as StorageError).kind).toBe("invalid-path");
		expect(spy.calls).toEqual([]);
	});

	it("rejects an invalid path on every method as a rejection, not a throw", async () => {
		const { mounts, spy } = await fixture();
		const mount = openMount(mounts, spy, "t");
		if (mount.mode !== "read-write") throw new Error("expected read-write");
		const attempts = [
			() => mount.list("../x"),
			() => mount.stat("../x"),
			() => mount.write("../x", Buffer.from("x")),
			() => mount.mkdir("../x"),
			() => mount.move("a", "../x", { overwrite: false }),
			() => mount.move("../x", "a", { overwrite: false }),
			() => mount.delete("../x"),
		];
		for (const attempt of attempts) {
			const error = await rejection(attempt());
			expect((error as StorageError).kind).toBe("invalid-path");
		}
		expect(spy.calls).toEqual([]);
	});
});

describe("MountView on a read-write mount", () => {
	it("move resolves both relative paths under the same mount", async () => {
		const { mounts, spy } = await fixture();
		const mount = openMount(mounts, spy, "t");
		if (mount.mode !== "read-write") throw new Error("expected read-write");
		await mount.write("a", Buffer.from("x"));
		await mount.move("a", "b", { overwrite: false });
		const move = spy.calls.find((c) => c.op === "move");
		expect(move?.args.map((p) => p.segments)).toEqual([
			["c", "a"],
			["c", "b"],
		]);
		expect(move?.args.every((p) => p.mount === "t")).toBe(true);
		expect(await mount.read("b")).toEqual(Buffer.from("x"));
	});
});
