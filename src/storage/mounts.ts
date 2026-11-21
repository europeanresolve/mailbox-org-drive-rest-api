import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { parseRelativePath, parseRootPath } from "./drive-path.ts";
import { StorageError } from "./errors.ts";

export type MountMode = "read" | "read-write";
export type MountDef = { path: string; mode: MountMode };
export type MountIssue = {
	code:
		| "mount.INVALID_NAME"
		| "mount.INVALID_PATH"
		| "mount.AT_ROOT"
		| "mount.OVERLAP";
	at: string;
};

const NAME_RULE = /^[a-z][a-z0-9-]{0,31}$/;

// Module-private: only code in this file can mint a ResolvedPath.
const TOKEN: symbol = Symbol("ResolvedPath");

/**
 * A Drive path proven to sit inside a configured mount. toString/toJSON/inspect
 * show the mount name and a short hash only, never segments (D-19).
 */
export class ResolvedPath {
	readonly mount: string;
	readonly segments: readonly string[];

	constructor(token: symbol, mount: string, segments: readonly string[]) {
		if (token !== TOKEN) {
			throw new StorageError("invalid-path", "resolve");
		}
		this.mount = mount;
		this.segments = Object.freeze([...segments]);
	}

	get ref(): string {
		return createHash("sha256")
			.update(this.segments.join("/"))
			.digest("hex")
			.slice(0, 8);
	}

	toString(): string {
		return `mount:${this.mount} ref:${this.ref}`;
	}

	toJSON(): { mount: string; ref: string } {
		return { mount: this.mount, ref: this.ref };
	}

	[inspect.custom](): string {
		return this.toString();
	}
}

type MountEntry = { name: string; mode: MountMode; root: ResolvedPath };

export class Mounts {
	readonly #entries: Map<string, MountEntry>;

	constructor(entries: Map<string, MountEntry>) {
		this.#entries = entries;
	}

	names(): string[] {
		return [...this.#entries.keys()];
	}

	get(name: string): MountEntry {
		const entry = this.#entries.get(name);
		if (entry === undefined) {
			throw new StorageError("unknown-mount", "resolve");
		}
		return entry;
	}

	resolve(name: string, rel: string): ResolvedPath {
		const entry = this.get(name);
		const root = entry.root.segments;
		const segments = [...root, ...parseRelativePath(rel)];
		const insideRoot = root.every((segment, i) => segments[i] === segment);
		if (!insideRoot || segments.length < root.length) {
			throw new StorageError("invalid-path", "resolve");
		}
		return new ResolvedPath(TOKEN, name, segments);
	}
}

export function buildMounts(
	defs: Record<string, MountDef>,
): { ok: true; mounts: Mounts } | { ok: false; issues: MountIssue[] } {
	const issues: MountIssue[] = [];
	const entries = new Map<string, MountEntry>();
	for (const [name, def] of Object.entries(defs)) {
		if (!NAME_RULE.test(name)) {
			issues.push({ code: "mount.INVALID_NAME", at: `/mounts/${name}` });
			continue;
		}
		const root = new ResolvedPath(TOKEN, name, parseRootPath(def.path));
		entries.set(name, { name, mode: def.mode, root });
	}
	if (issues.length > 0) return { ok: false, issues };
	return { ok: true, mounts: new Mounts(entries) };
}
