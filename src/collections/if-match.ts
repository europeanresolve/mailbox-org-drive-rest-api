/** What an If-Match header allows: any stored record, or one of these versions. */
export type IfMatch = { any: true } | { versions: number[] };

/** Scaffold so the RED run fails on its assertions, not on an import. */
export function parseIfMatch(_header: string | undefined): IfMatch | undefined {
	return undefined;
}
