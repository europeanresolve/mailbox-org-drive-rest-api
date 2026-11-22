/** What an If-Match header allows: any stored record, or one of these versions. */
export type IfMatch = { any: true } | { versions: number[] };

/** A strong entity tag as this service issues it: the version in double quotes. */
const STRONG_TAG = /^"(\d{1,15})"$/;

/**
 * Strong comparison (RFC 9110 section 13.1.1). Weak tags, unquoted values and
 * anything that is not a version number contribute no version, so a malformed
 * header matches nothing and the write answers 412 instead of overwriting.
 */
export function parseIfMatch(header: string | undefined): IfMatch | undefined {
	if (header === undefined) return undefined;
	if (header.trim() === "*") return { any: true };
	const versions: number[] = [];
	for (const entry of header.split(",")) {
		const found = STRONG_TAG.exec(entry.trim());
		if (found?.[1] !== undefined) versions.push(Number(found[1]));
	}
	return { versions };
}
