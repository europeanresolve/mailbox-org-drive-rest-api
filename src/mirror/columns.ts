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
