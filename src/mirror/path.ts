/** Drive-relative path of the mirror workbook for a collection name (D-06). */
export function mirrorFilePath(name: string): string {
	return `${name}.xlsx`;
}

/** Parent folder paths a nested collection name needs, innermost last. */
export function mirrorFolders(name: string): string[] {
	const parts = name.split("/");
	if (parts.length <= 1) return [];
	const out: string[] = [];
	for (let i = 1; i < parts.length; i++) {
		out.push(parts.slice(0, i).join("/"));
	}
	return out;
}

/** Last path segment of a collection name, at most 31 characters (D-24). */
export function mirrorSheetName(name: string): string {
	const segment = name.includes("/") ? (name.split("/").at(-1) ?? name) : name;
	return segment.slice(0, 31);
}
