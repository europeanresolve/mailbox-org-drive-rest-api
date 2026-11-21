import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findResidue } from "../helpers/synthetic-residue.ts";

// Samples are assembled at runtime so that no tracked file contains them.
const AT = "@";
const FIXTURE = "test/fixtures/ox/sample.xml";

const samples: { rule: string; path: string; text: string }[] = [
	{
		rule: "email",
		path: "README.md",
		text: `contact: jane.doe${AT}${["corp", "example", "de"].join(".")}`,
	},
	{
		rule: "ox-host",
		path: FIXTURE,
		text: `<D:href>${["https", "//", "files.", "provider.", "net"].join("")}/x</D:href>`,
	},
	{
		rule: "ox-date",
		path: FIXTURE,
		text: `<D:getlastmodified>Thu, 01 Jan ${2000 + 25} 00:00:00 GMT</D:getlastmodified>`,
	},
	{
		rule: "ox-quota",
		path: FIXTURE,
		text: `<D:quota-used-bytes>${123456}</D:quota-used-bytes>`,
	},
	{
		rule: "ox-name-element",
		path: FIXTURE,
		text: `<D:displayname>${["Jane", "Doe"].join(" ")}</D:displayname>`,
	},
];

describe("findResidue self-check", () => {
	for (const sample of samples) {
		it(`flags ${sample.rule}`, () => {
			expect(findResidue(sample.path, sample.text)).toContain(sample.rule);
		});
	}
});

describe("tracked files", () => {
	it("hold no residue", () => {
		const listed = execFileSync("git", ["ls-files", "-z"], {
			encoding: "utf8",
		})
			.split("\0")
			.filter((p) => p !== "" && p !== "pnpm-lock.yaml" && existsSync(p));
		const failures: string[] = [];
		for (const path of listed) {
			const bytes = readFileSync(path);
			if (bytes.includes(0)) continue;
			for (const rule of findResidue(path, bytes.toString("utf8"))) {
				failures.push(`${path}: ${rule}`);
			}
		}
		expect(failures).toEqual([]);
	});
});
