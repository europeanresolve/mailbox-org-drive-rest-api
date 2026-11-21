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

function isPrefix(a: readonly string[], b: readonly string[]): boolean {
	return a.length <= b.length && a.every((segment, i) => b[i] === segment);
}

// Case-sensitive on NFC segments: flagged assumption until the OX spike
// shows how the Drive compares names (P-14, U-09); plan 01-12 revisits it.
function overlaps(a: readonly string[], b: readonly string[]): boolean {
	return isPrefix(a, b) || isPrefix(b, a);
}

export function buildMounts(
	defs: Record<string, MountDef>,
): { ok: true; mounts: Mounts } | { ok: false; issues: MountIssue[] } {
	const issues: MountIssue[] = [];
	const entries = new Map<string, MountEntry>();
	for (const [name, def] of Object.entries(defs)) {
		const at = `/mounts/${name}`;
		if (!NAME_RULE.test(name)) {
			issues.push({ code: "mount.INVALID_NAME", at });
			continue;
		}
		let segments: string[];
		try {
			segments = parseRootPath(def.path);
		} catch (error) {
			if (!(error instanceof StorageError)) throw error;
			// Zero segments after the leading slash means the Drive root itself.
			const code = /^\/\/?$/.test(def.path)
				? "mount.AT_ROOT"
				: "mount.INVALID_PATH";
			issues.push({ code, at });
			continue;
		}
		entries.set(name, {
			name,
			mode: def.mode,
			root: new ResolvedPath(TOKEN, name, segments),
		});
	}
	// Each pair once (i < j, config order); an overlap needs a read-write side.
	const list = [...entries.values()];
	for (let i = 0; i < list.length; i++) {
		for (let j = i + 1; j < list.length; j++) {
			const a = list[i] as MountEntry;
			const b = list[j] as MountEntry;
			if (
				(a.mode === "read-write" || b.mode === "read-write") &&
				overlaps(a.root.segments, b.root.segments)
			) {
				issues.push({
					code: "mount.OVERLAP",
					at: `/mounts/${a.name} /mounts/${b.name}`,
				});
			}
		}
	}
	if (issues.length > 0) return { ok: false, issues };
	return { ok: true, mounts: new Mounts(entries) };
}
