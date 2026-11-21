import type { ReadOptions, StatEntry, StorageAdapter } from "./adapter.ts";
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

	list(rel: string): Promise<StatEntry[]> {
		return this.#adapter.list(this.#mounts.resolve(this.name, rel));
	}

	stat(rel: string): Promise<StatEntry> {
		return this.#adapter.stat(this.#mounts.resolve(this.name, rel));
	}

	read(rel: string, opts?: ReadOptions): Promise<Buffer> {
		return this.#adapter.read(this.#mounts.resolve(this.name, rel), opts);
	}

	write(rel: string, body: Buffer): Promise<StatEntry> {
		return this.#adapter.write(this.#mounts.resolve(this.name, rel), body);
	}

	mkdir(rel: string): Promise<void> {
		return this.#adapter.mkdir(this.#mounts.resolve(this.name, rel));
	}

	move(
		fromRel: string,
		toRel: string,
		opts: { overwrite: boolean },
	): Promise<void> {
		return this.#adapter.move(
			this.#mounts.resolve(this.name, fromRel),
			this.#mounts.resolve(this.name, toRel),
			opts,
		);
	}

	delete(rel: string): Promise<void> {
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
