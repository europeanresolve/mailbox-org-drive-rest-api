import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import type { RecordDocument } from "../collections/store.ts";
import type { Config } from "../config/schema.ts";
import { mirrorSheetName } from "./path.ts";

export type WorkbookNotes = { truncatedCells: number };

const TRUNC_SUFFIX = "…[truncated]";

type ScalarType = "string" | "number" | "integer" | "boolean";

function scalarColumns(
	schema: Config["collections"][string]["schema"],
): { key: string; type: ScalarType }[] {
	const properties = schema.properties as
		| Record<string, { type?: unknown }>
		| undefined;
	if (properties === undefined || typeof properties !== "object") return [];
	const out: { key: string; type: ScalarType }[] = [];
	for (const [key, def] of Object.entries(properties)) {
		if (def === null || typeof def !== "object" || Array.isArray(def)) continue;
		const type = (def as { type?: unknown }).type;
		if (
			type === "string" ||
			type === "number" ||
			type === "integer" ||
			type === "boolean"
		) {
			out.push({ key, type });
		}
	}
	return out;
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
	type: ScalarType,
	maxCellLength: number,
	notes: WorkbookNotes,
): string | number | boolean | null {
	if (raw === undefined || raw === null) return null;
	if (type === "boolean") return Boolean(raw);
	if (type === "integer" || type === "number") {
		return typeof raw === "number" ? raw : Number(raw);
	}
	const text =
		typeof raw === "string"
			? raw
			: typeof raw === "number" || typeof raw === "boolean"
				? String(raw)
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
	const columns = scalarColumns(schema);
	const header = ["id", ...columns.map((c) => c.key), "createdAt", "updatedAt"];
	const rows: unknown[][] = [header];
	const notes: WorkbookNotes = { truncatedCells: 0 };

	for (const record of records) {
		const row: unknown[] = [
			record._id,
			...columns.map((col) =>
				cellValue(record.data[col.key], col.type, options.maxCellLength, notes),
			),
			record.createdAt,
			record.updatedAt,
		];
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
