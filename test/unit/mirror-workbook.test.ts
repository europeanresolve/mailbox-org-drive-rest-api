import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import type { RecordDocument } from "../../src/collections/store.ts";
import {
	buildWorkbook,
	MIRROR_FORMAT_VERSION,
} from "../../src/mirror/workbook.ts";
import { readRows } from "../helpers/mirror.ts";

const flatSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		text: { type: "string" },
		count: { type: "integer" },
		flag: { type: "boolean" },
		born: { type: "string", format: "date" },
		seen: { type: "string", format: "date-time" },
		misc: { anyOf: [{ type: "string" }, { type: "number" }] },
		optional: { type: "string" },
	},
} as const;

function record(
	id: string,
	data: Record<string, unknown>,
	createdAt = "2026-01-15T10:00:00.000Z",
	updatedAt = createdAt,
): RecordDocument {
	return { _id: id, _v: 1, createdAt, updatedAt, data };
}

async function sheetCells(result: Awaited<ReturnType<typeof buildWorkbook>>) {
	const { cells, rows, sheet } = await readRows(result.buffer);
	return { cells, rows, sheet };
}

function cellAt(
	cells: Awaited<ReturnType<typeof sheetCells>>["cells"],
	row: number,
	col: number,
) {
	return cells[row]?.[col];
}

describe("buildWorkbook", () => {
	const formulaInputs = [
		"=1+1",
		"+49 30 1234",
		"-2",
		"@SUM(A1)",
		"\tx",
		"\rx",
		'=HYPERLINK("http://example.invalid","x")',
	];

	for (const [index, value] of formulaInputs.entries()) {
		it(`treats formula-like string ${index + 1} as plain text`, async () => {
			const built = await buildWorkbook(
				"inject",
				flatSchema,
				[record("1", { text: value })],
				{ maxCellLength: 32767 },
			);
			const { cells } = await sheetCells(built);
			const cell = cellAt(cells, 1, 1);
			expect(cell?.type).toBe(ExcelJS.ValueType.String);
			expect(cell?.formula).toBeUndefined();
			expect(cell?.hyperlink).toBeUndefined();
			// Excel normalises lone CR to LF in stored strings.
			const expected = value === "\rx" ? "\nx" : value;
			expect(cell?.value).toBe(expected);
		});
	}

	it("strips illegal XML and lone surrogates", async () => {
		const raw = "a\u0000b\u0008c\u000Bd\u001Fe\uFFFEf";
		const built = await buildWorkbook(
			"xml",
			flatSchema,
			[record("1", { text: `${raw}\uD800x😀y` })],
			{ maxCellLength: 32767 },
		);
		const { cells } = await sheetCells(built);
		expect(cellAt(cells, 1, 1)?.value).toBe("abcdefx😀y");
	});

	it("truncates at maxCellLength without splitting surrogates", async () => {
		const pad = "a".repeat(89);
		const value = `${pad}😀${"z".repeat(60)}`;
		const built = await buildWorkbook(
			"trunc",
			flatSchema,
			[record("1", { text: value })],
			{ maxCellLength: 100 },
		);
		expect(built.notes.truncatedCells).toBe(1);
		const { cells } = await sheetCells(built);
		const text = cellAt(cells, 1, 1)?.value as string;
		expect(text.length).toBe(100);
		expect(text.endsWith("…[truncated]")).toBe(true);
		expect(text.includes("\uD800")).toBe(false);
	});

	it("writes date-time and date fields as Date cells in UTC", async () => {
		const built = await buildWorkbook(
			"dates",
			flatSchema,
			[
				record("1", {
					seen: "2026-01-15T10:00:00.000Z",
					born: "2026-01-15",
				}),
			],
			{ maxCellLength: 32767 },
		);
		const { cells } = await sheetCells(built);
		const seen = cellAt(cells, 1, 5)?.value;
		const born = cellAt(cells, 1, 4)?.value;
		const createdAt = cellAt(cells, 1, 8)?.value;
		expect(seen).toEqual(new Date("2026-01-15T10:00:00.000Z"));
		expect(born).toEqual(new Date("2026-01-15T00:00:00.000Z"));
		expect(createdAt).toEqual(new Date("2026-01-15T10:00:00.000Z"));
	});

	it("keeps string shape for leading zeros and uses typed primitives", async () => {
		const built = await buildWorkbook(
			"types",
			flatSchema,
			[
				record("1", {
					text: "00123",
					count: 7,
					flag: true,
				}),
				record("2", { text: "y", optional: null }),
			],
			{ maxCellLength: 32767 },
		);
		const { cells } = await sheetCells(built);
		expect(cellAt(cells, 1, 1)?.value).toBe("00123");
		expect(cellAt(cells, 1, 2)?.value).toBe(7);
		expect(cellAt(cells, 1, 3)?.value).toBe(true);
		expect(cellAt(cells, 1, 7)?.value).toBeNull();
		expect(cellAt(cells, 2, 7)?.value).toBeNull();
	});

	it("json columns hold stringified sanitised values", async () => {
		const built = await buildWorkbook(
			"json",
			flatSchema,
			[record("1", { misc: { a: 1 } })],
			{ maxCellLength: 32767 },
		);
		const { cells } = await sheetCells(built);
		expect(cellAt(cells, 1, 6)?.value).toBe('{"a":1}');
	});

	it("names the sheet from the collection path and preserves row order", async () => {
		const long = `${"x".repeat(32)}`;
		const built = await buildWorkbook(
			`events/2026/${long}`,
			flatSchema,
			[
				record("first", { text: "one" }, "2026-01-01T00:00:00.000Z"),
				record("second", { text: "two" }, "2026-01-02T00:00:00.000Z"),
			],
			{ maxCellLength: 32767 },
		);
		const { sheet, rows } = await sheetCells(built);
		expect(sheet).toBe(long.slice(0, 31));
		expect(rows[1]?.[0]).toBe("first");
		expect(rows[2]?.[0]).toBe("second");
	});

	it("has a stable contentHash and reacts to data and layout changes", async () => {
		const input = [
			record("a", { text: "same" }),
			record("b", { text: "rows" }),
		];
		const a = await buildWorkbook("hash", flatSchema, input, {
			maxCellLength: 32767,
		});
		const b = await buildWorkbook("hash", flatSchema, input, {
			maxCellLength: 32767,
		});
		expect(a.contentHash).toBe(b.contentHash);
		expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);

		const changed = await buildWorkbook(
			"hash",
			flatSchema,
			[record("a", { text: "different" })],
			{ maxCellLength: 32767 },
		);
		expect(changed.contentHash).not.toBe(a.contentHash);

		const swapped = await buildWorkbook(
			"hash",
			{
				type: "object",
				properties: {
					other: { type: "string" },
					text: { type: "string" },
				},
			},
			input,
			{ maxCellLength: 32767 },
		);
		expect(swapped.contentHash).not.toBe(a.contentHash);

		expect(MIRROR_FORMAT_VERSION).toBeGreaterThanOrEqual(1);
	});

	it("freezes the header row", async () => {
		const built = await buildWorkbook(
			"freeze",
			flatSchema,
			[record("1", { text: "x" })],
			{ maxCellLength: 32767 },
		);
		const workbook = new ExcelJS.Workbook();
		await workbook.xlsx.load(built.buffer as unknown as ExcelJS.Buffer);
		const sheet = workbook.worksheets[0];
		const view = sheet?.views?.[0] as { ySplit?: number; state?: string };
		expect(view?.ySplit).toBe(1);
		expect(view?.state).toBe("frozen");
	});
});
