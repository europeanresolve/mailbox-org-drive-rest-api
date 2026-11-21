// RED stub: exports the final names but returns wrong results.
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

export class ResolvedPath {
	readonly mount = "";
	readonly segments: readonly string[] = [];
	get ref(): string {
		return "";
	}
	toString(): string {
		return "";
	}
	toJSON(): { mount: string; ref: string } {
		return { mount: "", ref: "" };
	}
}

export class Mounts {
	names(): string[] {
		return [];
	}
	get(_name: string): { name: string; mode: MountMode; root: ResolvedPath } {
		return { name: "", mode: "read", root: new ResolvedPath() };
	}
	resolve(_name: string, _rel: string): ResolvedPath {
		return new ResolvedPath();
	}
}

export function buildMounts(
	_defs: Record<string, MountDef>,
): { ok: true; mounts: Mounts } | { ok: false; issues: MountIssue[] } {
	return { ok: false, issues: [] };
}
