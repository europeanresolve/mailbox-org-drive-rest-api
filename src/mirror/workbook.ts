import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import type { RecordDocument } from "../collections/store.ts";
import type { Config } from "../config/schema.ts";
import { type Column, planColumns } from "./columns.ts";
import { mirrorSheetName } from "./path.ts";

export type WorkbookNotes = { truncatedCells: number };

export const MIRROR_FORMAT_VERSION = 1;

const TRUNC_SUFFIX = "…[truncated]";

function isIllegalXmlCode(unit: number): boolean {
	if (unit <= 0x8) return true;
	if (unit === 0xb || unit === 0xc) return true;
	if (unit >= 0xe && unit <= 0x1f) return true;
	if (unit === 0xfffe || unit === 0xffff) return true;
	return false;
}

function stripIllegalXml(text: string): string {
	let out = "";
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		if (isIllegalXmlCode(unit)) continue;
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				out += text.slice(index, index + 2);
				index += 1;
			}
			continue;
		}
		if (unit >= 0xdc00 && unit <= 0xdfff) continue;
		out += text[index];
	}
	return out;
}

type ModelValue = string | number | boolean | null;

type SheetModel = {
	name: string;
	headers: string[];
	rows: ModelValue[][];
};

export function sanitizeString(
	value: string,
	maxCellLength: number,
): { text: string; truncated: boolean } {
	const text = stripIllegalXml(value);
	if (text.length <= maxCellLength) {
		return { text, truncated: false };
	}
	const bodyLen = maxCellLength - TRUNC_SUFFIX.length;
	let cut = Math.max(bodyLen, 0);
	if (
		cut > 0 &&
		text.charCodeAt(cut - 1) >= 0xd800 &&
		text.charCodeAt(cut - 1) <= 0xdbff
	) {
		cut -= 1;
	}
	const prefix = cut > 0 ? text.slice(0, cut) : "";
	return { text: `${prefix}${TRUNC_SUFFIX}`, truncated: true };
}

function recordValue(record: RecordDocument, column: Column): unknown {
	if (column.header === "id") return record._id;
	if (column.header === "createdAt") return record.createdAt;
	if (column.header === "updatedAt") return record.updatedAt;
	let cur: unknown = record.data;
	for (const segment of column.path) {
		if (cur === null || cur === undefined || typeof cur !== "object") {
			return undefined;
		}
		cur = (cur as Record<string, unknown>)[segment];
	}
	return cur;
}

function writeSanitizedString(
	value: string,
	maxCellLength: number,
	notes: WorkbookNotes,
): string {
	const { text, truncated } = sanitizeString(value, maxCellLength);
	if (truncated) notes.truncatedCells += 1;
	return text;
}

function parseDate(raw: unknown, dateOnly: boolean): Date | null {
	if (raw === null || raw === undefined || raw === "") return null;
	const parsed = new Date(String(raw));
	if (Number.isNaN(parsed.getTime())) return null;
	if (dateOnly) {
		return new Date(
			Date.UTC(
				parsed.getUTCFullYear(),
				parsed.getUTCMonth(),
				parsed.getUTCDate(),
			),
		);
	}
	return parsed;
}

function modelValue(
	raw: unknown,
	kind: Column["kind"],
	maxCellLength: number,
	notes: WorkbookNotes,
): ModelValue {
	if (raw === undefined || raw === null) return null;
	switch (kind) {
		case "boolean":
			return typeof raw === "boolean" ? raw : Boolean(raw);
		case "number": {
			if (typeof raw === "number" && Number.isFinite(raw)) return raw;
			const num = Number(raw);
			return Number.isFinite(num) ? num : null;
		}
		case "date":
		case "date-time": {
			const date = parseDate(raw, kind === "date");
			return date === null ? null : date.toISOString();
		}
		case "json": {
			const json = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
			return writeSanitizedString(json, maxCellLength, notes);
		}
		case "string": {
			if (typeof raw !== "string") {
				return modelValue(raw, "json", maxCellLength, notes);
			}
			return writeSanitizedString(raw, maxCellLength, notes);
		}
		default:
			return writeSanitizedString(String(raw), maxCellLength, notes);
	}
}

function renderCell(
	cell: ExcelJS.Cell,
	value: ModelValue,
	kind: Column["kind"],
): void {
	if (value === null) {
		cell.value = null;
		return;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		cell.value = value;
		return;
	}
	if (kind === "date" || kind === "date-time") {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) {
			cell.value = date;
			cell.numFmt = kind === "date" ? "yyyy-mm-dd" : "yyyy-mm-dd hh:mm:ss";
			return;
		}
	}
	cell.value = value;
	cell.numFmt = "@";
}

function hashModel(model: SheetModel): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				v: MIRROR_FORMAT_VERSION,
				sheets: [model],
			}),
		)
		.digest("hex");
}

export async function buildWorkbook(
	name: string,
	schema: Config["collections"][string]["schema"],
	records: readonly RecordDocument[],
	options: { maxCellLength: number },
): Promise<{ buffer: Buffer; contentHash: string; notes: WorkbookNotes }> {
	const { main: columns } = planColumns(schema);
	const sheetName = mirrorSheetName(name);
	const notes: WorkbookNotes = { truncatedCells: 0 };

	const model: SheetModel = {
		name: sheetName,
		headers: columns.map((c) => c.header),
		rows: records.map((record) =>
			columns.map((col) =>
				modelValue(
					recordValue(record, col),
					col.kind,
					options.maxCellLength,
					notes,
				),
			),
		),
	};

	const contentHash = hashModel(model);

	const workbook = new ExcelJS.Workbook();
	workbook.creator = "";
	workbook.created = new Date(0);
	workbook.modified = new Date(0);
	const sheet = workbook.addWorksheet(sheetName);
	sheet.views = [{ state: "frozen", ySplit: 1, topLeftCell: "A2" }];

	sheet.addRow(model.headers);

	for (const rowValues of model.rows) {
		const row = sheet.addRow([]);
		for (let index = 0; index < columns.length; index += 1) {
			const column = columns[index];
			const value = rowValues[index] ?? null;
			if (column === undefined) continue;
			renderCell(row.getCell(index + 1), value, column.kind);
		}
	}

	const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

	return { buffer, contentHash, notes };
}
