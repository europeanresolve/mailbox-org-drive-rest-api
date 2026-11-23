import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import type { RecordDocument } from "../collections/store.ts";
import type { Config } from "../config/schema.ts";
import {
	type ArrayField,
	type ArraySheetColumn,
	type ArraySheetPlan,
	type Column,
	planArraySheets,
	planColumns,
} from "./columns.ts";
import { mirrorSheetName } from "./path.ts";
import { SheetNamer } from "./sheet-names.ts";

export type WorkbookNotes = { truncatedCells: number; omittedSheets: number };

export const MIRROR_FORMAT_VERSION = 1;

const TRUNC_SUFFIX = "…[truncated]";
const MAX_SHEETS = 255;

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

type CellModel = { value: ModelValue; formula?: string };

type SheetModel = {
	name: string;
	headers: string[];
	rows: CellModel[][];
};

type RowRange = { first: number; last: number };

type BuiltArraySheet = {
	name: string;
	plan: ArraySheetPlan;
	headers: string[];
	rows: ModelValue[][];
	recordRanges: Map<string, RowRange>;
};

type MainColumn =
	| (Column & { arrayFieldIndex?: undefined })
	| {
			header: string;
			path: readonly string[];
			kind: Column["kind"];
			arrayFieldIndex: number;
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

function valueAtPath(root: unknown, path: readonly string[]): unknown {
	let cur: unknown = root;
	for (const segment of path) {
		if (cur === null || cur === undefined || typeof cur !== "object") {
			return undefined;
		}
		cur = (cur as Record<string, unknown>)[segment];
	}
	return cur;
}

function recordValue(record: RecordDocument, column: Column): unknown {
	if (column.header === "id") return record._id;
	if (column.header === "createdAt") return record.createdAt;
	if (column.header === "updatedAt") return record.updatedAt;
	return valueAtPath(record.data, column.path);
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
	kind: Column["kind"] | ArraySheetColumn["kind"],
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

function buildMainColumns(
	columns: Column[],
	arrays: ArrayField[],
): MainColumn[] {
	const result: MainColumn[] = [...columns];
	let offset = 0;
	for (let index = 0; index < arrays.length; index += 1) {
		const field = arrays[index];
		if (field === undefined) continue;
		const insertAt = field.position + 1 + offset;
		result.splice(insertAt, 0, {
			header: field.path.join("."),
			path: field.path,
			kind: "string",
			arrayFieldIndex: index,
		});
		offset += 1;
	}
	return result;
}

export function textJoinFormula(
	sheetName: string,
	firstRow: number,
	lastRow: number,
): string {
	return `_xlfn.TEXTJOIN(", ",TRUE,'${sheetName}'!$C$${firstRow}:$C$${lastRow})`;
}

export function countIfFormula(
	sheetName: string,
	firstRow: number,
	lastRow: number,
	mainRow: number,
): string {
	return `COUNTIF('${sheetName}'!$A$${firstRow}:$A$${lastRow},A${mainRow})`;
}

function computeTextJoinCached(
	items: unknown[],
	maxCellLength: number,
	notes: WorkbookNotes,
): string {
	const parts: string[] = [];
	for (const item of items) {
		const text = modelValue(item, "string", maxCellLength, notes);
		if (text === null || text === "") continue;
		parts.push(String(text));
	}
	let joined = parts.join(", ");
	if (joined.length > maxCellLength) {
		joined = writeSanitizedString(joined, maxCellLength, notes);
	}
	return joined;
}

function emptyRange(): RowRange {
	return { first: 0, last: 0 };
}

function trackRange(
	ranges: Map<string, RowRange>,
	recordId: string,
	rowNumber: number,
): void {
	const existing = ranges.get(recordId);
	if (existing === undefined || existing.first === 0) {
		ranges.set(recordId, { first: rowNumber, last: rowNumber });
		return;
	}
	existing.last = rowNumber;
}

function scalarArrayRows(
	record: RecordDocument,
	items: unknown[],
	columns: ArraySheetColumn[],
	maxCellLength: number,
	notes: WorkbookNotes,
): ModelValue[][] {
	const rows: ModelValue[][] = [];
	for (let index = 0; index < items.length; index += 1) {
		const row: ModelValue[] = [];
		for (const col of columns) {
			if (col.header === "id") row.push(record._id);
			else if (col.header === "index") row.push(index);
			else if (col.header === "value") {
				row.push(modelValue(items[index], col.kind, maxCellLength, notes));
			} else {
				row.push(null);
			}
		}
		rows.push(row);
	}
	return rows;
}

function objectAt(item: unknown, prop: string): unknown {
	if (item === null || item === undefined || typeof item !== "object") {
		return undefined;
	}
	return (item as Record<string, unknown>)[prop];
}

function objectArrayRows(
	record: RecordDocument,
	items: unknown[],
	columns: ArraySheetColumn[],
	maxCellLength: number,
	notes: WorkbookNotes,
): ModelValue[][] {
	const rows: ModelValue[][] = [];
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		const row: ModelValue[] = [];
		for (const col of columns) {
			if (col.header === "id") row.push(record._id);
			else if (col.header === "index") row.push(index);
			else {
				row.push(
					modelValue(
						objectAt(item, col.header),
						col.kind,
						maxCellLength,
						notes,
					),
				);
			}
		}
		rows.push(row);
	}
	return rows;
}

function nestedArrayValue(
	outerItem: unknown,
	nestedPath: readonly string[],
): unknown {
	if (nestedPath.length === 0) return outerItem;
	let cur: unknown = outerItem;
	for (const segment of nestedPath) {
		if (segment === "__inner__") {
			continue;
		}
		if (cur === null || cur === undefined || typeof cur !== "object") {
			return undefined;
		}
		cur = (cur as Record<string, unknown>)[segment];
	}
	return cur;
}

function buildTopLevelArraySheet(
	plan: ArraySheetPlan,
	allocatedName: string,
	records: readonly RecordDocument[],
	maxCellLength: number,
	notes: WorkbookNotes,
): BuiltArraySheet {
	const headers = plan.columns.map((c) => c.header);
	const rows: ModelValue[][] = [];
	const recordRanges = new Map<string, RowRange>();
	let rowNumber = 1;

	for (const record of records) {
		const raw = valueAtPath(record.data, plan.path);
		const items = Array.isArray(raw) ? raw : [];
		if (items.length === 0) {
			recordRanges.set(record._id, emptyRange());
			continue;
		}
		const batch =
			plan.summaryKind === "textjoin" ||
			plan.columns.some((c) => c.header === "value")
				? scalarArrayRows(record, items, plan.columns, maxCellLength, notes)
				: objectArrayRows(record, items, plan.columns, maxCellLength, notes);
		for (const row of batch) {
			rowNumber += 1;
			rows.push(row);
			trackRange(recordRanges, record._id, rowNumber);
		}
	}

	return {
		name: allocatedName,
		plan,
		headers,
		rows,
		recordRanges,
	};
}

type ElementSheetSpec = {
	allocatedName: string;
	columns: ArraySheetColumn[];
	path: readonly string[];
	nestedPath: readonly string[];
	outerIndex: number;
};

function buildElementSheetRows(
	spec: ElementSheetSpec,
	records: readonly RecordDocument[],
	maxCellLength: number,
	notes: WorkbookNotes,
): ModelValue[][] {
	const rows: ModelValue[][] = [];
	for (const record of records) {
		const raw = valueAtPath(record.data, spec.path);
		const items = Array.isArray(raw) ? raw : [];
		const outerItem = items[spec.outerIndex];
		if (outerItem === undefined) continue;
		const nested = nestedArrayValue(outerItem, spec.nestedPath);
		const nestedItems = Array.isArray(nested) ? nested : [];
		for (let index = 0; index < nestedItems.length; index += 1) {
			const row: ModelValue[] = [];
			for (const col of spec.columns) {
				if (col.header === "id") row.push(record._id);
				else if (col.header === "index") row.push(index);
				else if (col.header === "value") {
					row.push(
						modelValue(nestedItems[index], col.kind, maxCellLength, notes),
					);
				} else {
					row.push(
						modelValue(
							objectAt(nestedItems[index], col.header),
							col.kind,
							maxCellLength,
							notes,
						),
					);
				}
			}
			rows.push(row);
		}
	}
	return rows;
}

function summaryCell(
	plan: ArraySheetPlan,
	sheetName: string,
	range: RowRange,
	mainRow: number,
	rawArray: unknown,
	maxCellLength: number,
	notes: WorkbookNotes,
): CellModel {
	if (rawArray === undefined || rawArray === null) {
		return { value: null };
	}
	if (!Array.isArray(rawArray)) {
		return { value: null };
	}
	if (rawArray.length === 0 || range.first === 0) {
		return { value: "" };
	}
	if (plan.summaryKind === "textjoin") {
		return {
			value: computeTextJoinCached(rawArray, maxCellLength, notes),
			formula: textJoinFormula(sheetName, range.first, range.last),
		};
	}
	return {
		value: rawArray.length,
		formula: countIfFormula(sheetName, range.first, range.last, mainRow),
	};
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

function renderCellModel(
	cell: ExcelJS.Cell,
	model: CellModel,
	kind: Column["kind"],
): void {
	if (model.formula !== undefined) {
		const result = model.value === null ? "" : (model.value as string | number);
		cell.value = { formula: model.formula, result };
		return;
	}
	renderCell(cell, model.value, kind);
}

function hashSheets(sheets: SheetModel[]): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				v: MIRROR_FORMAT_VERSION,
				sheets,
			}),
		)
		.digest("hex");
}

function writeSheet(
	workbook: ExcelJS.Workbook,
	model: SheetModel,
	kinds: (Column["kind"] | undefined)[],
): void {
	const sheet = workbook.addWorksheet(model.name);
	sheet.views = [{ state: "frozen", ySplit: 1, topLeftCell: "A2" }];
	sheet.addRow(model.headers);
	for (const rowValues of model.rows) {
		const row = sheet.addRow([]);
		for (let index = 0; index < rowValues.length; index += 1) {
			const cellModel = rowValues[index];
			const kind = kinds[index] ?? "string";
			if (cellModel === undefined) continue;
			renderCellModel(row.getCell(index + 1), cellModel, kind);
		}
	}
}

export async function buildWorkbook(
	name: string,
	schema: Config["collections"][string]["schema"],
	records: readonly RecordDocument[],
	options: { maxCellLength: number },
): Promise<{ buffer: Buffer; contentHash: string; notes: WorkbookNotes }> {
	const { main: baseColumns, arrays } = planColumns(schema);
	const arrayPlans = planArraySheets(arrays);
	const mainColumns = buildMainColumns(baseColumns, arrays);
	const notes: WorkbookNotes = { truncatedCells: 0, omittedSheets: 0 };

	const namer = new SheetNamer();
	const mainSheetName = namer.reserve(mirrorSheetName(name));

	const arraySheetNames = arrayPlans.map((plan) =>
		namer.name(plan.sheetCandidate),
	);

	let sheetCount = 1 + arraySheetNames.length;

	const builtArraySheets = arrayPlans.map((plan, index) =>
		buildTopLevelArraySheet(
			plan,
			arraySheetNames[index] ?? plan.sheetCandidate,
			records,
			options.maxCellLength,
			notes,
		),
	);

	const elementSheets: {
		name: string;
		headers: string[];
		rows: ModelValue[][];
	}[] = [];
	for (const [_planIndex, plan] of arrayPlans.entries()) {
		const templates = plan.elementTemplates;
		if (templates === undefined || templates.length === 0) continue;
		const maxOuter = records.reduce((max, record) => {
			const raw = valueAtPath(record.data, plan.path);
			const len = Array.isArray(raw) ? raw.length : 0;
			return Math.max(max, len);
		}, 0);
		for (const template of templates) {
			for (let outerIndex = 0; outerIndex < maxOuter; outerIndex += 1) {
				if (sheetCount >= MAX_SHEETS) {
					notes.omittedSheets += 1;
					continue;
				}
				const candidate = template.sheetCandidate(outerIndex);
				const allocated = namer.name(candidate);
				const rows = buildElementSheetRows(
					{
						allocatedName: allocated,
						columns: template.columns,
						path: plan.path,
						nestedPath: template.nestedPath,
						outerIndex,
					},
					records,
					options.maxCellLength,
					notes,
				);
				elementSheets.push({
					name: allocated,
					headers: template.columns.map((c) => c.header),
					rows,
				});
				sheetCount += 1;
			}
		}
	}

	const mainRows: CellModel[][] = records.map((record, recordIndex) => {
		const mainRow = recordIndex + 2;
		return mainColumns.map((col) => {
			if (col.arrayFieldIndex !== undefined) {
				const field = arrays[col.arrayFieldIndex];
				const plan = arrayPlans[col.arrayFieldIndex];
				const sheet = builtArraySheets[col.arrayFieldIndex];
				if (field === undefined || plan === undefined || sheet === undefined) {
					return { value: null };
				}
				const raw = valueAtPath(record.data, field.path);
				const range = sheet.recordRanges.get(record._id) ?? emptyRange();
				return summaryCell(
					plan,
					sheet.name,
					range,
					mainRow,
					raw,
					options.maxCellLength,
					notes,
				);
			}
			return {
				value: modelValue(
					recordValue(record, col),
					col.kind,
					options.maxCellLength,
					notes,
				),
			};
		});
	});

	const mainKinds = mainColumns.map((c) => c.kind);

	const sheetModels: SheetModel[] = [
		{
			name: mainSheetName,
			headers: mainColumns.map((c) => c.header),
			rows: mainRows,
		},
		...builtArraySheets.map((sheet) => ({
			name: sheet.name,
			headers: sheet.headers,
			rows: sheet.rows.map((row) => row.map((value) => ({ value }))),
		})),
		...elementSheets.map((sheet) => ({
			name: sheet.name,
			headers: sheet.headers,
			rows: sheet.rows.map((row) => row.map((value) => ({ value }))),
		})),
	];

	const mainModel = sheetModels[0];
	if (mainModel === undefined) {
		throw new Error("workbook model missing main sheet");
	}

	const contentHash = hashSheets(sheetModels);

	const workbook = new ExcelJS.Workbook();
	workbook.creator = "";
	workbook.created = new Date(0);
	workbook.modified = new Date(0);

	writeSheet(workbook, mainModel, mainKinds);

	for (const built of builtArraySheets) {
		const model: SheetModel = {
			name: built.name,
			headers: built.headers,
			rows: built.rows.map((row) => row.map((value) => ({ value }))),
		};
		writeSheet(
			workbook,
			model,
			built.plan.columns.map((c) => c.kind),
		);
	}

	for (const sheet of elementSheets) {
		const model: SheetModel = {
			name: sheet.name,
			headers: sheet.headers,
			rows: sheet.rows.map((row) => row.map((value) => ({ value }))),
		};
		writeSheet(
			workbook,
			model,
			sheet.headers.map(() => "string"),
		);
	}

	const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

	return { buffer, contentHash, notes };
}
