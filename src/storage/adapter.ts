import type { ResolvedPath } from "./mounts.ts";

/** Default cap for `read` when the caller passes no `maxBytes` (25 MiB). */
export const DEFAULT_MAX_READ_BYTES = 25 * 1024 * 1024;

export type ReadOptions = { maxBytes?: number };

export type StatEntry = {
	name: string;
	kind: "file" | "dir";
	size: number;
	/** Opaque equality token. It is never sent back as If-Match. */
	etag: string | null;
	lastModified: Date | null;
};

/**
 * Storage port. Every method rejects only with `StorageError` (errors.ts), so
 * callers and the shared contract suite reason about error kinds, never about
 * backend-specific HTTP statuses.
 */
export interface StorageAdapter {
	stat(p: ResolvedPath): Promise<StatEntry>;
	/** Shallow listing, the folder itself excluded, sorted by name in code-unit order. */
	list(p: ResolvedPath): Promise<StatEntry[]>;
	read(p: ResolvedPath, opts?: ReadOptions): Promise<Buffer>;
	write(p: ResolvedPath, body: Buffer): Promise<StatEntry>;
	/** Strict: an existing folder is a conflict. */
	mkdir(p: ResolvedPath): Promise<void>;
	move(
		from: ResolvedPath,
		to: ResolvedPath,
		opts: { overwrite: boolean },
	): Promise<void>;
	/** Files only: a folder, empty or not, is a conflict. */
	delete(p: ResolvedPath): Promise<void>;
}
