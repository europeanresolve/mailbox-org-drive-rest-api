import type { ReadOptions, StatEntry, StorageAdapter } from "./adapter.ts";
import type { ResolvedPath } from "./mounts.ts";

// RED stub: every method rejects until the GREEN commit implements it.
export class MemoryAdapter implements StorageAdapter {
	stat(_p: ResolvedPath): Promise<StatEntry> {
		return Promise.reject(new Error("not implemented"));
	}
	list(_p: ResolvedPath): Promise<StatEntry[]> {
		return Promise.reject(new Error("not implemented"));
	}
	read(_p: ResolvedPath, _opts?: ReadOptions): Promise<Buffer> {
		return Promise.reject(new Error("not implemented"));
	}
	write(_p: ResolvedPath, _body: Buffer): Promise<StatEntry> {
		return Promise.reject(new Error("not implemented"));
	}
	mkdir(_p: ResolvedPath): Promise<void> {
		return Promise.reject(new Error("not implemented"));
	}
	move(
		_from: ResolvedPath,
		_to: ResolvedPath,
		_opts: { overwrite: boolean },
	): Promise<void> {
		return Promise.reject(new Error("not implemented"));
	}
	delete(_p: ResolvedPath): Promise<void> {
		return Promise.reject(new Error("not implemented"));
	}
}
