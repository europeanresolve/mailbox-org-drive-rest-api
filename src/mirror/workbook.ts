import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import type { RecordDocument } from "../collections/store.ts";
import type { Config } from "../config/schema.ts";
import { type Column, planColumns } from "./columns.ts";
import { mirrorSheetName } from "./path.ts";

export type WorkbookNotes = { truncatedCells: number };

const TRUNC_SUFFIX = "…[truncated]";

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

function truncateString(value: string, maxLen: number): string {
	if (value.length <= maxLen) return value;
	if (maxLen <= TRUNC_SUFFIX.length) {
		return TRUNC_SUFFIX.slice(0, maxLen);
	}
	return `${value.slice(0, maxLen - TRUNC_SUFFIX.length)}${TRUNC_SUFFIX}`;
}

function cellValue(
	raw: unknown,
	kind: Column["kind"],
	maxCellLength: number,
	notes: WorkbookNotes,
): string | number | boolean | null {
	if (raw === undefined || raw === null) return null;
	if (kind === "boolean") return Boolean(raw);
	if (kind === "number") {
		return typeof raw === "number" ? raw : Number(raw);
	}
	const text =
		typeof raw === "string"
			? raw
			: typeof raw === "number" || typeof raw === "boolean"
				? String(raw)
				: kind === "json" && raw !== undefined
					? JSON.stringify(raw)
					: null;
	if (text === null) return null;
	if (text.length > maxCellLength) {
		notes.truncatedCells += 1;
		return truncateString(text, maxCellLength);
	}
	return text;
}

export async function buildWorkbook(
	name: string,
	schema: Config["collections"][string]["schema"],
	records: readonly RecordDocument[],
	options: { maxCellLength: number },
): Promise<{ buffer: Buffer; contentHash: string; notes: WorkbookNotes }> {
	const { main: columns } = planColumns(schema);
	const header = columns.map((c) => c.header);
	const rows: unknown[][] = [header];
	const notes: WorkbookNotes = { truncatedCells: 0 };

	for (const record of records) {
		const row = columns.map((col) =>
			cellValue(
				recordValue(record, col),
				col.kind,
				options.maxCellLength,
				notes,
			),
		);
		rows.push(row);
	}

	const workbook = new ExcelJS.Workbook();
	workbook.creator = "";
	workbook.created = new Date(0);
	workbook.modified = new Date(0);
	const sheet = workbook.addWorksheet(mirrorSheetName(name));
	for (const row of rows) {
		sheet.addRow(row);
	}
	const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

	const contentHash = createHash("sha256")
		.update(JSON.stringify(rows))
		.digest("hex");

	return { buffer, contentHash, notes };
}
