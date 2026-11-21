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

export type MountView = ReadableMount | WritableMount;

// RED stub: implemented in the GREEN commit.
export function openMount(
	_mounts: Mounts,
	_adapter: StorageAdapter,
	_name: string,
): ReadableMount | WritableMount {
	throw new Error("not implemented");
}
