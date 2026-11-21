import type { ReadOptions, StatEntry, StorageAdapter } from "./adapter.ts";
import { StorageError } from "./errors.ts";
import type { Mounts } from "./mounts.ts";

export type ReadableMount = {
	readonly name: string;
	readonly mode: "read";
	list(rel: string): Promise<StatEntry[]>;
	stat(rel: string): Promise<StatEntry>;
	read(rel: string, opts?: ReadOptions): Promise<Buffer>;
};

export type WritableMount = Omit<ReadableMount, "mode"> & {
	readonly mode: "read-write";
	write(rel: string, body: Buffer): Promise<StatEntry>;
	mkdir(rel: string): Promise<void>;
	move(
		fromRel: string,
		toRel: string,
		opts: { overwrite: boolean },
	): Promise<void>;
	delete(rel: string): Promise<void>;
};

/**
 * One class backs both mount types. Every relative path goes through
 * `mounts.resolve` before any adapter call, so path errors surface first.
 * Methods are async so every failure is a rejection, never a sync throw.
 * Write methods check the mode first: a read mount cannot reach the adapter
 * even when the type-level guard is bypassed with a cast (STOR-02, T-01-20).
 */
export class MountView {
	readonly name: string;
	readonly mode: "read" | "read-write";
	readonly #mounts: Mounts;
	readonly #adapter: StorageAdapter;

	constructor(mounts: Mounts, adapter: StorageAdapter, name: string) {
		this.#mounts = mounts;
		this.#adapter = adapter;
		this.name = name;
		this.mode = mounts.get(name).mode;
	}

	#assertWritable(op: string): void {
		if (this.mode === "read") throw new StorageError("read-only-mount", op);
	}

	async list(rel: string): Promise<StatEntry[]> {
		return this.#adapter.list(this.#mounts.resolve(this.name, rel));
	}

	async stat(rel: string): Promise<StatEntry> {
		return this.#adapter.stat(this.#mounts.resolve(this.name, rel));
	}

	async read(rel: string, opts?: ReadOptions): Promise<Buffer> {
		return this.#adapter.read(this.#mounts.resolve(this.name, rel), opts);
	}

	async write(rel: string, body: Buffer): Promise<StatEntry> {
		this.#assertWritable("write");
		return this.#adapter.write(this.#mounts.resolve(this.name, rel), body);
	}

	async mkdir(rel: string): Promise<void> {
		this.#assertWritable("mkdir");
		return this.#adapter.mkdir(this.#mounts.resolve(this.name, rel));
	}

	async move(
		fromRel: string,
		toRel: string,
		opts: { overwrite: boolean },
	): Promise<void> {
		this.#assertWritable("move");
		return this.#adapter.move(
			this.#mounts.resolve(this.name, fromRel),
			this.#mounts.resolve(this.name, toRel),
			opts,
		);
	}

	async delete(rel: string): Promise<void> {
		this.#assertWritable("delete");
		return this.#adapter.delete(this.#mounts.resolve(this.name, rel));
	}
}

export function openMount(
	mounts: Mounts,
	adapter: StorageAdapter,
	name: string,
): ReadableMount | WritableMount {
	return new MountView(mounts, adapter, name) as ReadableMount | WritableMount;
}
