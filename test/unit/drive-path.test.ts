import { describe, expect, it } from "vitest";
import { StorageError } from "../../src/storage/errors.ts";
import { buildMounts, type Mounts } from "../../src/storage/mounts.ts";

function testMounts(): Mounts {
	const built = buildMounts({ t: { path: "/root/t", mode: "read-write" } });
	if (!built.ok) throw new Error("expected buildMounts to succeed");
	return built.mounts;
}

const ROOT = ["root", "t"];

function expectInvalid(rel: string): void {
	let error: unknown;
	try {
		testMounts().resolve("t", rel);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(StorageError);
	expect((error as StorageError).kind).toBe("invalid-path");
}

const rejected: Array<[string, string]> = [
	["dot-dot", ".."],
	["dot-dot in the middle", "a/../b"],
	["leading dot-dot", "../x"],
	["trailing dot-dot", "a/.."],
	["single dot", "."],
	["double slash only", "//"],
	["empty middle segment", "a//b"],
	["absolute path", "/etc"],
	["trailing slash", "a/"],
	["backslash", "a\\b"],
	["backslash traversal", "a\\..\\b"],
	["NUL byte", "\u0000x"],
	["fullwidth dots", "\uff0e\uff0e"],
	["one-dot leaders", "\u2024\u2024"],
	["two-dot leader", "\u2025"],
	["small-form dots", "\ufe52\ufe52"],
	["fullwidth solidus", "a\uff0fb"],
	["tab", "a\tb"],
	["newline", "a\nb"],
	["DEL", "a\u007fb"],
	["C1 control", "a\u0085b"],
	["256-byte segment", "a".repeat(256)],
];

const allowed: Array<[string, string, string[]]> = [
	["the mount root", "", []],
	["literal %2e%2e", "%2e%2e", ["%2e%2e"]],
	["literal ..%2f", "..%2f", ["..%2f"]],
	["drive-letter-like name", "C:", ["C:"]],
	[
		"comma, space, ampersand, hash, plus",
		"Last, First/a&b#1+x.txt",
		["Last, First", "a&b#1+x.txt"],
	],
	["254-byte segment", "ü".repeat(127), ["ü".repeat(127)]],
	["255-byte segment", "a".repeat(255), ["a".repeat(255)]],
];

describe("traversal corpus (STOR-03)", () => {
	for (const [name, input] of rejected) {
		it(`rejects ${name}`, () => {
			expectInvalid(input);
		});
	}

	for (const [name, input, expected] of allowed) {
		it(`allows ${name} and stays inside the mount`, () => {
			const resolved = testMounts().resolve("t", input);
			expect(resolved.segments).toEqual([...ROOT, ...expected]);
		});
	}

	it("stores NFD and NFC spellings of the same name identically", () => {
		const nfd = testMounts().resolve("t", "Mu\u0308ller");
		const nfc = testMounts().resolve("t", "M\u00fcller");
		expect(nfd.segments).toEqual(nfc.segments);
		expect(nfd.segments.at(-1)).toBe("M\u00fcller");
	});
});

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// An accepted segment must not smuggle a separator, a dot segment or a control
// character, either as written or after NFKC folding.
function isSafeAfterNfkc(segment: string): boolean {
	for (const form of [segment, segment.normalize("NFKC")]) {
		if (form === "" || form === "." || form === "..") return false;
		for (const char of form) {
			const code = char.codePointAt(0) ?? 0;
			if (char === "/" || char === "\\") return false;
			if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
		}
	}
	return true;
}

describe("seeded property test (STOR-03)", () => {
	const alphabet = [
		".",
		"/",
		"\\",
		"%",
		"2",
		"e",
		"\u0000",
		"\uff0e",
		"\uff0f",
		"a",
		"\u00fc",
	];

	it("2000 random inputs never escape the mount", () => {
		const mounts = testMounts();
		const random = mulberry32(0xc0ffee);
		const counterExamples: string[] = [];
		for (let i = 0; i < 2000; i++) {
			const length = Math.floor(random() * 13);
			let input = "";
			for (let j = 0; j < length; j++) {
				input += alphabet[Math.floor(random() * alphabet.length)];
			}
			try {
				const { segments } = mounts.resolve("t", input);
				const ok =
					ROOT.every((s, k) => segments[k] === s) &&
					segments.every(
						(s) =>
							s !== "" &&
							s !== "." &&
							s !== ".." &&
							s === s.normalize("NFC") &&
							isSafeAfterNfkc(s),
					);
				if (!ok) counterExamples.push(JSON.stringify(input));
			} catch (error) {
				if (!(error instanceof StorageError) || error.kind !== "invalid-path") {
					counterExamples.push(JSON.stringify(input));
				}
			}
		}
		expect(counterExamples).toEqual([]);
	});
});
