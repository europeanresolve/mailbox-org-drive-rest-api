import { StorageError } from "./errors.ts";

const MAX_SEGMENT_BYTES = 255;

function isBad(form: string): boolean {
	if (form === "" || form === "." || form === "..") return true;
	for (const char of form) {
		const code = char.codePointAt(0) ?? 0;
		if (char === "/" || char === "\\") return true;
		// C0 controls (incl. NUL), DEL and C1 controls.
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
	}
	return false;
}

// Input arrives already decoded once by the router and is never decoded again:
// a literal "%2e%2e" is a file name. The raw form and its NFKC fold are both
// checked, so compatibility dots and solidi cannot pose as "." ".." or "/".
function checkSegment(segment: string): string {
	const nfc = segment.normalize("NFC");
	if (
		isBad(segment) ||
		isBad(segment.normalize("NFKC")) ||
		Buffer.byteLength(nfc, "utf8") > MAX_SEGMENT_BYTES
	) {
		throw new StorageError("invalid-path", "resolve");
	}
	return nfc;
}

/** Relative path inside a mount: "" is the mount root itself. */
export function parseRelativePath(input: string): string[] {
	if (input === "") return [];
	return input.split("/").map(checkSegment);
}

/** Absolute mount root: leading "/", at most one trailing "/", never the Drive root. */
export function parseRootPath(input: string): string[] {
	if (!input.startsWith("/")) {
		throw new StorageError("invalid-path", "resolve");
	}
	let rest = input.slice(1);
	if (rest.endsWith("/")) rest = rest.slice(0, -1);
	const segments = rest === "" ? [] : rest.split("/").map(checkSegment);
	if (segments.length === 0) {
		throw new StorageError("invalid-path", "resolve");
	}
	return segments;
}
