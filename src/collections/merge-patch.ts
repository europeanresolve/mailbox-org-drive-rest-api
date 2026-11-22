/** Scaffold so the RED run fails on its assertions, not on an import. */
export function applyMergePatch(target: unknown, _patch: unknown): unknown {
	return target;
}
