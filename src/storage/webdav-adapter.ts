import type { ReadOptions, StatEntry, StorageAdapter } from "./adapter.ts";
import { StorageError } from "./errors.ts";
import type { ResolvedPath } from "./mounts.ts";

export type WebDavAdapterOptions = {
	url: string;
	username: string;
	password: string;
};

const notImplemented = (op: string): never => {
	throw new StorageError("unavailable", op);
};

/** RED skeleton: every method rejects until the behaviour is implemented. */
export class WebDavAdapter implements StorageAdapter {
	constructor(_options: WebDavAdapterOptions) {}

	async stat(_p: ResolvedPath): Promise<StatEntry> {
		return notImplemented("stat");
	}

	async list(_p: ResolvedPath): Promise<StatEntry[]> {
		return notImplemented("list");
	}

	async read(_p: ResolvedPath, _opts?: ReadOptions): Promise<Buffer> {
		return notImplemented("read");
	}

	async write(_p: ResolvedPath, _body: Buffer): Promise<StatEntry> {
		return notImplemented("write");
	}

	async mkdir(_p: ResolvedPath): Promise<void> {
		return notImplemented("mkdir");
	}

	async move(
		_from: ResolvedPath,
		_to: ResolvedPath,
		_opts: { overwrite: boolean },
	): Promise<void> {
		return notImplemented("move");
	}

	async delete(_p: ResolvedPath): Promise<void> {
		return notImplemented("delete");
	}
}
