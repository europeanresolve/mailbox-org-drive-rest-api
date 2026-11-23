import type { Config } from "../config/schema.ts";

export type ColumnKind =
	| "string"
	| "number"
	| "boolean"
	| "date"
	| "date-time"
	| "json";

export type Column = {
	header: string;
	path: readonly string[];
	kind: ColumnKind;
};

export type ArrayField = {
	path: readonly string[];
	items: unknown;
	position: number;
};

export type ColumnPlan = {
	main: Column[];
	arrays: ArrayField[];
};

export type SummaryKind = "textjoin" | "countif";

export type ArraySheetColumn = {
	header: string;
	kind: ColumnKind;
};

export type ElementSheetTemplate = {
	sheetCandidate: (outerIndex: number) => string;
	nestedPath: readonly string[];
	columns: ArraySheetColumn[];
	summaryKind: SummaryKind;
	elementTemplates?: ElementSheetTemplate[];
};

export type ArraySheetPlan = {
	path: readonly string[];
	sheetCandidate: string;
	columns: ArraySheetColumn[];
	summaryKind: SummaryKind;
	elementTemplates?: ElementSheetTemplate[];
};

type JsonSchema = {
	type?: unknown;
	format?: unknown;
	properties?: unknown;
	items?: unknown;
	anyOf?: unknown;
	oneOf?: unknown;
	allOf?: unknown;
	$ref?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonSchema(value: unknown): value is JsonSchema {
	return isRecord(value);
}

function resolveScalarType(
	def: JsonSchema,
): ColumnKind | "array" | "object" | "json" {
	if (
		def.anyOf !== undefined ||
		def.oneOf !== undefined ||
		def.allOf !== undefined
	) {
		return "json";
	}
	if (def.$ref !== undefined) return "json";

	let type = def.type;
	if (type === undefined) {
		if (isRecord(def.properties)) return "object";
		return "json";
	}
	if (Array.isArray(type)) {
		const nonNull = type.filter((t) => t !== "null");
		if (nonNull.length === 1) {
			type = nonNull[0];
		} else {
			return "json";
		}
	}

	if (type === "string") {
		if (def.format === "date") return "date";
		if (def.format === "date-time") return "date-time";
		return "string";
	}
	if (type === "number" || type === "integer") return "number";
	if (type === "boolean") return "boolean";
	if (type === "array") return "array";
	if (type === "object") {
		if (!isRecord(def.properties)) return "json";
		return "object";
	}
	return "json";
}

function walkProperties(
	properties: Record<string, unknown>,
	prefix: readonly string[],
	main: Column[],
	arrays: ArrayField[],
): void {
	for (const [key, raw] of Object.entries(properties)) {
		if (!isJsonSchema(raw)) continue;
		const path = [...prefix, key];
		const header = path.join(".");
		const resolved = resolveScalarType(raw);

		if (resolved === "object") {
			const nested = raw.properties;
			if (isRecord(nested)) {
				walkProperties(nested, path, main, arrays);
				continue;
			}
		}

		if (resolved === "array") {
			arrays.push({
				path,
				items: raw.items,
				position: main.length > 0 ? main.length - 1 : 0,
			});
			continue;
		}

		const kind: ColumnKind = resolved === "object" ? "json" : resolved;
		main.push({ header, path, kind });
	}
}

export function planColumns(
	schema: Config["collections"][string]["schema"],
): ColumnPlan {
	const main: Column[] = [{ header: "id", path: [], kind: "string" }];
	const arrays: ArrayField[] = [];

	if (isRecord(schema.properties)) {
		walkProperties(schema.properties, [], main, arrays);
	}

	main.push(
		{ header: "createdAt", path: ["createdAt"], kind: "date-time" },
		{ header: "updatedAt", path: ["updatedAt"], kind: "date-time" },
	);

	return { main, arrays };
}

function itemScalarKind(def: JsonSchema): ColumnKind {
	const resolved = resolveScalarType(def);
	if (resolved === "array" || resolved === "object" || resolved === "json") {
		return "json";
	}
	return resolved;
}

function isScalarArrayItem(items: unknown): boolean {
	if (!isJsonSchema(items)) return true;
	const resolved = resolveScalarType(items);
	return resolved !== "array" && resolved !== "object";
}

function fieldPathKey(path: readonly string[]): string {
	return path.join(".");
}

function planNestedElementTemplates(
	outerPath: readonly string[],
	prefix: readonly string[],
	properties: Record<string, unknown>,
): ElementSheetTemplate[] {
	const templates: ElementSheetTemplate[] = [];
	for (const [key, raw] of Object.entries(properties)) {
		if (!isJsonSchema(raw)) continue;
		const nestedPath = [...prefix, key];
		if (resolveScalarType(raw) !== "array") continue;
		const base = fieldPathKey(outerPath);
		const nestedKey = fieldPathKey(nestedPath);
		const items = raw.items;
		const template: ElementSheetTemplate = {
			nestedPath,
			sheetCandidate: (outerIndex) => `${base}(${outerIndex}).${nestedKey}`,
			columns: [],
			summaryKind: "textjoin",
			elementTemplates: [],
		};
		if (isScalarArrayItem(items)) {
			template.columns = [
				{ header: "id", kind: "string" },
				{ header: "index", kind: "number" },
				{
					header: "value",
					kind: itemScalarKind(isJsonSchema(items) ? items : {}),
				},
			];
		} else if (isJsonSchema(items) && resolveScalarType(items) === "object") {
			const props = items.properties;
			const cols: ArraySheetColumn[] = [
				{ header: "id", kind: "string" },
				{ header: "index", kind: "number" },
			];
			if (isRecord(props)) {
				for (const [propKey, propDef] of Object.entries(props)) {
					if (!isJsonSchema(propDef)) continue;
					if (resolveScalarType(propDef) === "array") continue;
					cols.push({
						header: propKey,
						kind: itemScalarKind(propDef),
					});
				}
				template.elementTemplates = planNestedElementTemplates(
					outerPath,
					[...nestedPath],
					props,
				);
			}
			template.columns = cols;
			template.summaryKind = "countif";
		} else if (isJsonSchema(items) && resolveScalarType(items) === "array") {
			template.columns = [
				{ header: "id", kind: "string" },
				{ header: "index", kind: "number" },
			];
			template.summaryKind = "countif";
			const innerBase = `${base}(${0}).${nestedKey}`;
			template.elementTemplates = [
				{
					nestedPath: [...nestedPath, "__inner__"],
					sheetCandidate: (innerIndex) =>
						`${innerBase.replace(`(${0})`, `(${innerIndex})`)}(${innerIndex})`,
					columns: [
						{ header: "id", kind: "string" },
						{ header: "index", kind: "number" },
						{ header: "value", kind: "number" },
					],
					summaryKind: "textjoin",
				},
			];
		}
		templates.push(template);
	}
	return templates;
}

export function planArraySheets(
	arrays: readonly ArrayField[],
): ArraySheetPlan[] {
	return arrays.map((field) => {
		const sheetCandidate = fieldPathKey(field.path);
		const items = field.items;

		if (!isJsonSchema(items)) {
			return {
				path: field.path,
				sheetCandidate,
				columns: [
					{ header: "id", kind: "string" },
					{ header: "index", kind: "number" },
					{ header: "value", kind: "json" },
				],
				summaryKind: "textjoin",
			};
		}

		const itemType = resolveScalarType(items);

		if (itemType === "array") {
			const inner = items.items;
			const valueKind = isJsonSchema(inner) ? itemScalarKind(inner) : "json";
			const base = sheetCandidate;
			return {
				path: field.path,
				sheetCandidate,
				columns: [
					{ header: "id", kind: "string" },
					{ header: "index", kind: "number" },
				],
				summaryKind: "countif",
				elementTemplates: [
					{
						nestedPath: field.path,
						sheetCandidate: (outerIndex) => `${base}(${outerIndex})`,
						columns: [
							{ header: "id", kind: "string" },
							{ header: "index", kind: "number" },
							{ header: "value", kind: valueKind },
						],
						summaryKind: "textjoin",
					},
				],
			};
		}

		if (itemType === "object" && isRecord(items.properties)) {
			const cols: ArraySheetColumn[] = [
				{ header: "id", kind: "string" },
				{ header: "index", kind: "number" },
			];
			for (const [key, raw] of Object.entries(items.properties)) {
				if (!isJsonSchema(raw)) continue;
				if (resolveScalarType(raw) === "array") continue;
				cols.push({ header: key, kind: itemScalarKind(raw) });
			}
			return {
				path: field.path,
				sheetCandidate,
				columns: cols,
				summaryKind: "countif",
				elementTemplates: planNestedElementTemplates(
					field.path,
					[],
					items.properties,
				),
			};
		}

		return {
			path: field.path,
			sheetCandidate,
			columns: [
				{ header: "id", kind: "string" },
				{ header: "index", kind: "number" },
				{ header: "value", kind: itemScalarKind(items) },
			],
			summaryKind: "textjoin",
		};
	});
}
