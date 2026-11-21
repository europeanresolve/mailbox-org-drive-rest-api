import { createHash } from "node:crypto";
import type { ReadOptions, StatEntry, StorageAdapter } from "./adapter.ts";
import { DEFAULT_MAX_READ_BYTES } from "./adapter.ts";
import { StorageError } from "./errors.ts";
import type { ResolvedPath } from "./mounts.ts";

type Node =
	| { kind: "dir"; lastModified: Date }
	| { kind: "file"; body: Buffer; etag: string; lastModified: Date };

const keyOf = (segments: readonly string[]): string => segments.join("/");

const parentKey = (segments: readonly string[]): string =>
	keyOf(segments.slice(0, -1));

/**
 * In-memory adapter that mimics the WebDAV semantics the shared contract
 * fixes. Buffers are copied on the way in and out. The root "" is a dir.
 */
export class MemoryAdapter implements StorageAdapter {
	readonly #nodes = new Map<string, Node>([
		["", { kind: "dir", lastModified: new Date() }],
	]);

	#entry(p: ResolvedPath, node: Node): StatEntry {
		const name = p.segments.at(-1) ?? "";
		if (node.kind === "dir") {
			return {
				name,
				kind: "dir",
				size: 0,
				etag: null,
				lastModified: node.lastModified,
			};
		}
		return {
			name,
			kind: "file",
			size: node.body.length,
			etag: node.etag,
			lastModified: node.lastModified,
		};
	}

	async stat(p: ResolvedPath): Promise<StatEntry> {
		const node = this.#nodes.get(keyOf(p.segments));
		if (node === undefined) throw new StorageError("not-found", "stat");
		return this.#entry(p, node);
	}

	list(_p: ResolvedPath): Promise<StatEntry[]> {
		return Promise.reject(new Error("not implemented"));
	}

	async read(p: ResolvedPath, opts?: ReadOptions): Promise<Buffer> {
		const node = this.#nodes.get(keyOf(p.segments));
		if (node === undefined) throw new StorageError("not-found", "read");
		if (node.kind === "dir") throw new StorageError("conflict", "read");
		const max = opts?.maxBytes ?? DEFAULT_MAX_READ_BYTES;
		if (node.body.length > max) throw new StorageError("too-large", "read");
		return Buffer.from(node.body);
	}

	async write(p: ResolvedPath, body: Buffer): Promise<StatEntry> {
		const parent = this.#nodes.get(parentKey(p.segments));
		if (parent?.kind !== "dir") throw new StorageError("conflict", "write");
		const copy = Buffer.from(body);
		const node: Node = {
			kind: "file",
			body: copy,
			etag: createHash("sha256").update(copy).digest("hex").slice(0, 16),
			lastModified: new Date(),
		};
		this.#nodes.set(keyOf(p.segments), node);
		return this.#entry(p, node);
	}

	async mkdir(p: ResolvedPath): Promise<void> {
		const key = keyOf(p.segments);
		if (this.#nodes.has(key)) throw new StorageError("conflict", "mkdir");
		const parent = this.#nodes.get(parentKey(p.segments));
		if (parent?.kind !== "dir") throw new StorageError("conflict", "mkdir");
		this.#nodes.set(key, { kind: "dir", lastModified: new Date() });
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
