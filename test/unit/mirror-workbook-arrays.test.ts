import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { RecordDocument } from "../../src/collections/store.ts";
import { buildWorkbook } from "../../src/mirror/workbook.ts";
import { readRows } from "../helpers/mirror.ts";

const arraySchema = {
	type: "object",
	properties: {
		email: { type: "string" },
		tags: { type: "array", items: { type: "string" } },
		address: {
			type: "object",
			properties: {
				lines: { type: "array", items: { type: "string" } },
			},
		},
		systems: {
			type: "array",
			items: {
				type: "object",
				properties: {
					name: { type: "string" },
					planets: { type: "array", items: { type: "string" } },
				},
			},
		},
	},
} as const;

function record(
	id: string,
	data: Record<string, unknown>,
	createdAt = "2026-01-15T10:00:00.000Z",
): RecordDocument {
	return { _id: id, _v: 1, createdAt, updatedAt: createdAt, data };
}

const FORMULA_RE =
	/^(_xlfn\.TEXTJOIN\(", ",TRUE,'[^']+'!\$C\$\d+:\$C\$\d+\)|COUNTIF\('[^']+'!\$A\$\d+:\$A\$\d+,A\d+\))$/;

async function workbookSheetNames(buffer: Buffer): Promise<string[]> {
	const wb = new ExcelJS.Workbook();
	await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
	return wb.worksheets.map((s) => s.name);
}

async function allFormulaStrings(buffer: Buffer): Promise<string[]> {
	const wb = new ExcelJS.Workbook();
	await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
	const out: string[] = [];
	for (const sheet of wb.worksheets) {
		sheet.eachRow((row) => {
			row.eachCell({ includeEmpty: false }, (cell) => {
				if (cell.formula) out.push(cell.formula);
			});
		});
	}
	return out;
}

describe("buildWorkbook array sheets", () => {
	const trio = [
		record("r1", {
			email: "a@ex.invalid",
			tags: ["a", "b", "c"],
			address: { lines: ["l1"] },
			systems: [
				{ name: "s1", planets: ["p1", "p2"] },
				{ name: "s2", planets: ["p3"] },
			],
		}),
		record("r2", {
			email: "b@ex.invalid",
			tags: [],
			address: { lines: [] },
			systems: [],
		}),
		record("r3", {
			email: "c@ex.invalid",
			tags: ["d"],
			address: { lines: ["l2", "l3"] },
			systems: [{ name: "s3", planets: ["p4"] }],
		}),
	];

	it("creates array sheets in schema order with item rows", async () => {
		const built = await buildWorkbook("contact", arraySchema, trio, {
			maxCellLength: 32767,
		});
		const names = await workbookSheetNames(built.buffer);
		expect(names).toEqual([
			"contact",
			"tags",
			"address.lines",
			"systems",
			"systems(0).planets",
			"systems(1).planets",
		]);

		const tags = await readRows(built.buffer, "tags");
		expect(tags.rows[0]).toEqual(["id", "index", "value"]);
		expect(tags.rows.slice(1)).toEqual([
			["r1", 0, "a"],
			["r1", 1, "b"],
			["r1", 2, "c"],
			["r3", 0, "d"],
		]);
	});

	it("writes TEXTJOIN and COUNTIF summary cells with cached results", async () => {
		const built = await buildWorkbook("contact", arraySchema, trio, {
			maxCellLength: 32767,
		});
		const main = await readRows(built.buffer, "contact");
		const tagsCol = main.rows[0]?.indexOf("tags") ?? -1;
		const systemsCol = main.rows[0]?.indexOf("systems") ?? -1;
		expect(tagsCol).toBeGreaterThan(-1);
		expect(systemsCol).toBeGreaterThan(-1);

		const r1Tags = main.cells[1]?.[tagsCol];
		expect(r1Tags?.formula).toBe(
			"_xlfn.TEXTJOIN(\", \",TRUE,'tags'!$C$2:$C$4)",
		);
		expect(r1Tags?.value).toBe("a, b, c");

		const r2Tags = main.cells[2]?.[tagsCol];
		expect(r2Tags?.formula).toBeUndefined();
		expect(r2Tags?.value).toBe("");

		const r3Tags = main.cells[3]?.[tagsCol];
		expect(r3Tags?.formula).toBe(
			"_xlfn.TEXTJOIN(\", \",TRUE,'tags'!$C$5:$C$5)",
		);

		const r1Systems = main.cells[1]?.[systemsCol];
		expect(r1Systems?.formula).toBe("COUNTIF('systems'!$A$2:$A$3,A2)");
		expect(r1Systems?.value).toBe(2);
	});

	it("scopes nested element sheets to the matching outer index", async () => {
		const built = await buildWorkbook("contact", arraySchema, trio, {
			maxCellLength: 32767,
		});
		const planets1 = await readRows(built.buffer, "systems(1).planets");
		expect(planets1.rows.slice(1)).toEqual([["r1", 0, "p3"]]);
	});

	it("keeps formula injection inert and satisfies the formula contract", async () => {
		const built = await buildWorkbook(
			"contact",
			arraySchema,
			[record("x", { tags: ["=1+1"], email: "x" })],
			{ maxCellLength: 32767 },
		);
		const tags = await readRows(built.buffer, "tags");
		expect(tags.cells[1]?.[2]?.type).toBe(ExcelJS.ValueType.String);
		const formulas = await allFormulaStrings(built.buffer);
		const blob = formulas.join("\n");
		expect(blob).not.toContain("=1+1");
		expect(blob).not.toContain("@");
		expect(blob).not.toContain("x");
		for (const f of formulas) {
			expect(f).toMatch(FORMULA_RE);
		}
	});

	it("caps sheets at 255 and records omitted element sheets", async () => {
		const systems = Array.from({ length: 300 }, (_, i) => ({
			name: `s${i}`,
			planets: [`p${i}`],
		}));
		const built = await buildWorkbook(
			"cap",
			{
				type: "object",
				properties: {
					systems: {
						type: "array",
						items: {
							type: "object",
							properties: {
								name: { type: "string" },
								planets: { type: "array", items: { type: "string" } },
							},
						},
					},
				},
			},
			[record("big", { systems })],
			{ maxCellLength: 32767 },
		);
		const names = await workbookSheetNames(built.buffer);
		expect(names.length).toBeLessThanOrEqual(255);
		expect(built.notes.omittedSheets).toBeGreaterThan(0);
	});

	it("changes contentHash when array data changes", async () => {
		const base = [record("a", { tags: ["one"] })];
		const a = await buildWorkbook("hash", arraySchema, base, {
			maxCellLength: 32767,
		});
		const b = await buildWorkbook("hash", arraySchema, base, {
			maxCellLength: 32767,
		});
		expect(a.contentHash).toBe(b.contentHash);
		const changed = await buildWorkbook(
			"hash",
			arraySchema,
			[record("a", { tags: ["two"] })],
			{ maxCellLength: 32767 },
		);
		expect(changed.contentHash).not.toBe(a.contentHash);
	});
});
