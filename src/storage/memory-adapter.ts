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
		return this.#entryOf(p.segments.at(-1) ?? "", node);
	}

	#entryOf(name: string, node: Node): StatEntry {
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

	async list(p: ResolvedPath): Promise<StatEntry[]> {
		const node = this.#nodes.get(keyOf(p.segments));
		if (node === undefined) throw new StorageError("not-found", "list");
		if (node.kind !== "dir") throw new StorageError("conflict", "list");
		const entries: StatEntry[] = [];
		for (const [key, child] of this.#nodes) {
			if (key === "") continue;
			const segments = key.split("/");
			if (
				segments.length === p.segments.length + 1 &&
				p.segments.every((s, i) => segments[i] === s)
			) {
				entries.push(this.#entryOf(segments.at(-1) ?? "", child));
			}
		}
		// Code-unit order, not locale order.
		return entries.sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
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
		if (this.#nodes.get(keyOf(p.segments))?.kind === "dir") {
			throw new StorageError("conflict", "write");
		}
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

	async move(
		from: ResolvedPath,
		to: ResolvedPath,
		opts: { overwrite: boolean },
	): Promise<void> {
		const fromKey = keyOf(from.segments);
		const toKey = keyOf(to.segments);
		// Compared by segments before any state is read or changed.
		if (fromKey === toKey) throw new StorageError("conflict", "move");
		const source = this.#nodes.get(fromKey);
		if (source === undefined) throw new StorageError("not-found", "move");
		if (toKey.startsWith(`${fromKey}/`)) {
			throw new StorageError("conflict", "move");
		}
		if (this.#nodes.get(parentKey(to.segments))?.kind !== "dir") {
			throw new StorageError("conflict", "move");
		}
		const existing = this.#nodes.get(toKey);
		if (existing !== undefined) {
			// Never replace a folder: that would drop staff work.
			if (!opts.overwrite || existing.kind === "dir") {
				throw new StorageError("conflict", "move");
			}
		}
		const moving = [...this.#nodes].filter(
			([key]) => key === fromKey || key.startsWith(`${fromKey}/`),
		);
		for (const [key] of moving) this.#nodes.delete(key);
		for (const [key, node] of moving) {
			this.#nodes.set(toKey + key.slice(fromKey.length), node);
		}
	}

	async delete(p: ResolvedPath): Promise<void> {
		const key = keyOf(p.segments);
		const node = this.#nodes.get(key);
		if (node === undefined) throw new StorageError("not-found", "delete");
		// Files only: no folder is ever deleted, empty or not.
		if (node.kind === "dir") throw new StorageError("conflict", "delete");
		this.#nodes.delete(key);
	}
}
