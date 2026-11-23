import { describe, expect, it } from "vitest";
import type { ArrayField } from "../../src/mirror/columns.ts";
import { planArraySheets } from "../../src/mirror/columns.ts";
import { SheetNamer } from "../../src/mirror/sheet-names.ts";

describe("SheetNamer", () => {
	it("returns path-like candidates unchanged when short and unique", () => {
		const namer = new SheetNamer();
		namer.reserve("contact");
		expect(namer.name("tags")).toBe("tags");
		expect(namer.name("address.lines")).toBe("address.lines");
		expect(namer.name("systems(0).planets")).toBe("systems(0).planets");
	});

	it("cuts long names and assigns ~N suffixes", () => {
		const namer = new SheetNamer();
		namer.reserve("contact");
		const long = "a".repeat(40);
		expect(namer.name(long)).toBe(`${"a".repeat(29)}~2`);
		expect(namer.name(`${"a".repeat(29)}extra`)).toBe(`${"a".repeat(29)}~3`);
	});

	it("deduplicates case-insensitively and reserves History", () => {
		const namer = new SheetNamer();
		namer.reserve("contact");
		expect(namer.name("tags")).toBe("tags");
		expect(namer.name("Tags")).toBe("Tags~2");
		expect(namer.name("history")).toBe("history~2");
	});

	it("keeps names at most 31 characters without forbidden characters", () => {
		const namer = new SheetNamer();
		namer.reserve("main");
		const names = [
			namer.name("x".repeat(50)),
			namer.name("tags"),
			namer.name("TAGS"),
		];
		for (const name of names) {
			expect(name.length).toBeLessThanOrEqual(31);
			expect(name).not.toMatch(/[:\\/?*\[\]]/);
		}
		expect(new SheetNamer().name("tags")).toBe("tags");
		expect(new SheetNamer().name("tags")).toBe("tags");
	});
});

describe("planArraySheets", () => {
	it("plans a scalar string array sheet", () => {
		const arrays: ArrayField[] = [
			{ path: ["tags"], items: { type: "string" }, position: 1 },
		];
		const plans = planArraySheets(arrays);
		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({
			sheetCandidate: "tags",
			summaryKind: "textjoin",
			columns: [
				{ header: "id", kind: "string" },
				{ header: "index", kind: "number" },
				{ header: "value", kind: "string" },
			],
		});
	});

	it("plans object arrays with nested element templates", () => {
		const arrays: ArrayField[] = [
			{
				path: ["systems"],
				items: {
					type: "object",
					properties: {
						name: { type: "string" },
						planets: { type: "array", items: { type: "string" } },
					},
				},
				position: 2,
			},
		];
		const plans = planArraySheets(arrays);
		expect(plans).toHaveLength(1);
		const outer = plans[0];
		expect(outer?.sheetCandidate).toBe("systems");
		expect(outer?.summaryKind).toBe("countif");
		expect(outer?.columns.map((c) => c.header)).toEqual(["id", "index", "name"]);
		const template = outer?.elementTemplates?.[0];
		expect(template?.sheetCandidate(0)).toBe("systems(0).planets");
		expect(template?.sheetCandidate(1)).toBe("systems(1).planets");
		expect(template?.columns.map((c) => c.header)).toEqual([
			"id",
			"index",
			"value",
		]);
		expect(template?.summaryKind).toBe("textjoin");
	});

	it("plans matrix (array of array) with per-index element sheets", () => {
		const arrays: ArrayField[] = [
			{
				path: ["matrix"],
				items: { type: "array", items: { type: "number" } },
				position: 0,
			},
		];
		const plans = planArraySheets(arrays);
		expect(plans).toHaveLength(1);
		const outer = plans[0];
		expect(outer?.sheetCandidate).toBe("matrix");
		expect(outer?.summaryKind).toBe("countif");
		expect(outer?.columns.map((c) => c.header)).toEqual(["id", "index"]);
		const template = outer?.elementTemplates?.[0];
		expect(template?.sheetCandidate(0)).toBe("matrix(0)");
		expect(template?.columns.map((c) => c.header)).toEqual([
			"id",
			"index",
			"value",
		]);
	});
});