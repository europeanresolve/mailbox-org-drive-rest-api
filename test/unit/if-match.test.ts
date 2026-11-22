import { describe, expect, it } from "vitest";
import { parseIfMatch } from "../../src/collections/if-match.ts";

// Compared as strings: TAP failure output must stay on one line to count as RED evidence.
const parsed = (header: string | undefined): string =>
	JSON.stringify(parseIfMatch(header)) ?? "undefined";

describe("parseIfMatch", () => {
	it("gives undefined for an absent header", () => {
		expect(parsed(undefined)).toBe("undefined");
	});

	it("gives { any: true } for *", () => {
		expect(parsed("*")).toBe(JSON.stringify({ any: true }));
		expect(parsed(" * ")).toBe(JSON.stringify({ any: true }));
	});

	it("reads one strong entity tag", () => {
		expect(parsed('"3"')).toBe(JSON.stringify({ versions: [3] }));
	});

	it("reads a list and keeps every entry", () => {
		expect(parsed('"1", "2"')).toBe(JSON.stringify({ versions: [1, 2] }));
		expect(parsed('"1","2",  "3"')).toBe(
			JSON.stringify({ versions: [1, 2, 3] }),
		);
	});

	it("never matches a weak tag", () => {
		expect(parsed('W/"1"')).toBe(JSON.stringify({ versions: [] }));
		expect(parsed('"1", W/"2"')).toBe(JSON.stringify({ versions: [1] }));
	});

	it.each([
		["abc"],
		['"x"'],
		['"1'],
		['""'],
		['"-1"'],
		['"1.5"'],
		['"1e3"'],
		['"99999999999999999999"'],
		[""],
	])("a malformed value %j matches nothing", (value) => {
		expect(parsed(value)).toBe(JSON.stringify({ versions: [] }));
	});
});
