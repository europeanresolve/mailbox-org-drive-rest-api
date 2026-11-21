import { StorageError } from "./errors.ts";

// Tracer rule set: empty, "." and "..". Task 2 adds the full rules test-first.
// Input arrives already decoded once by the router and is never decoded again.
function checkSegment(segment: string): string {
	if (segment === "" || segment === "." || segment === "..") {
		throw new StorageError("invalid-path", "resolve");
	}
	return segment.normalize("NFC");
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
