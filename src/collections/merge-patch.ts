function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A plain data property, so a member literally named `__proto__` can never reach a prototype. */
function define(target: Record<string, unknown>, key: string, value: unknown) {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

/**
 * RFC 7396 MergePatch. A patch that is not an object replaces the target;
 * an object patch merges member by member, `null` removes, arrays and scalars
 * replace. Returns a new value along every patched path and never mutates
 * `target` or `patch`.
 */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
	if (!isObject(patch)) return patch;
	const result: Record<string, unknown> = {};
	if (isObject(target)) {
		for (const [key, value] of Object.entries(target))
			define(result, key, value);
	}
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete result[key];
		} else {
			const current = Object.hasOwn(result, key) ? result[key] : undefined;
			define(result, key, applyMergePatch(current, value));
		}
	}
	return result;
}
