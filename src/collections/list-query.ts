import {
	FILTER_OPERATORS,
	resolveIndexPath,
	type ScalarType,
} from "./definition.ts";
import type { RecordDocument } from "./store.ts";

export type Scalar = string | number | boolean;
export type FilterOp = (typeof FILTER_OPERATORS)[number];
const OPERATORS: ReadonlySet<string> = new Set(FILTER_OPERATORS);

export type ListCondition = { field: string; op: FilterOp; value: Scalar };

export type ParsedList = {
	filters: ListCondition[];
	/** `field` is the MongoDB field; `spec` is the query form (`-createdAt`) that a cursor is bound to. */
	sort: { field: string; dir: 1 | -1; spec: string };
	limit: number;
	after?: { v: Scalar; id: string };
};

export type ListQueryCode =
	| "bad_query"
	| "unknown_parameter"
	| "repeated_parameter"
	| "bad_value"
	| "bad_sort"
	| "bad_limit"
	| "bad_cursor";

/** Carries a code and nothing from the request: no key, value or cursor ever reaches a message or a field. */
export class ListQueryError extends Error {
	readonly code: ListQueryCode;

	constructor(code: ListQueryCode) {
		super(code);
		this.name = "ListQueryError";
		this.code = code;
	}
}

type FieldType = ScalarType | "date";
type Field = { mongo: string; type: FieldType };

export type ListCollection = {
	readonly schema: { readonly [keyword: string]: unknown };
	readonly indexes?: readonly string[];
};

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
const DEFAULT_SORT = "-createdAt";
const MAX_CURSOR_LENGTH = 2048;

const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const tables = new WeakMap<ListCollection, ReadonlyMap<string, Field>>();

/** The fields a query may name: createdAt, updatedAt and each indexed path. A Map, so no key reaches a prototype. */
function fieldsOf(collection: ListCollection): ReadonlyMap<string, Field> {
	const cached = tables.get(collection);
	if (cached !== undefined) return cached;
	const fields = new Map<string, Field>([
		["createdAt", { mongo: "createdAt", type: "date" }],
		["updatedAt", { mongo: "updatedAt", type: "date" }],
	]);
	for (const path of collection.indexes ?? []) {
		const resolved = resolveIndexPath({ ...collection.schema }, path);
		if ("type" in resolved) {
			fields.set(path, { mongo: `data.${path}`, type: resolved.type });
		}
	}
	tables.set(collection, fields);
	return fields;
}

const INTEGER = /^-?(0|[1-9][0-9]*)$/;
const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
// A full date, or an RFC 3339 date-time with an explicit zone. No lenient forms.
const DATE_TIME =
	/^(\d{4})-(\d{2})-(\d{2})(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

/** Normalised to toISOString form, which is how createdAt and updatedAt are stored. */
function parseDate(raw: string): string | undefined {
	const match = DATE_TIME.exec(raw);
	if (match === null) return undefined;
	const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
		number,
		number,
		number,
	];
	// Date accepts 2026-02-30 and rolls it over; the same calendar day must come back.
	const probe = new Date(0);
	probe.setUTCFullYear(year, month - 1, day);
	if (
		probe.getUTCFullYear() !== year ||
		probe.getUTCMonth() !== month - 1 ||
		probe.getUTCDate() !== day
	) {
		return undefined;
	}
	const ms = raw.includes("T") ? Date.parse(raw) : probe.getTime();
	return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** One entry per schema type: the only place a raw query string becomes a JS scalar. */
const TYPING: Record<FieldType, (raw: string) => Scalar | undefined> = {
	string: (raw) => raw,
	integer: (raw) => {
		const n = Number(raw);
		// `+ 0` turns -0 into 0.
		return INTEGER.test(raw) && Number.isSafeInteger(n) ? n + 0 : undefined;
	},
	number: (raw) => {
		const n = Number(raw);
		return DECIMAL.test(raw) && Number.isFinite(n) ? n + 0 : undefined;
	},
	boolean: (raw) =>
		raw === "true" ? true : raw === "false" ? false : undefined,
	date: parseDate,
};

function typed(field: Field, op: FilterOp, raw: string): Scalar {
	// A boolean has no order, so only equality.
	if (field.type === "boolean" && op !== "eq") {
		throw new ListQueryError("bad_value");
	}
	const value = TYPING[field.type](raw);
	if (value === undefined) throw new ListQueryError("bad_value");
	return value;
}

function parseLimit(raw: string): number {
	if (!/^[1-9][0-9]{0,2}$/.test(raw)) throw new ListQueryError("bad_limit");
	const limit = Number(raw);
	if (limit > MAX_LIMIT) throw new ListQueryError("bad_limit");
	return limit;
}

export function encodeCursor(cursor: {
	s: string;
	v: unknown;
	id: string;
}): string {
	return Buffer.from(
		JSON.stringify({ s: cursor.s, v: cursor.v, id: cursor.id }),
	).toString("base64url");
}

function cursorValueOk(type: FieldType, v: unknown): v is Scalar {
	switch (type) {
		case "date":
			return typeof v === "string" && ISO_Z.test(v);
		case "string":
			return typeof v === "string";
		case "integer":
			return typeof v === "number" && Number.isSafeInteger(v);
		case "number":
			return typeof v === "number" && Number.isFinite(v);
		case "boolean":
			return typeof v === "boolean";
	}
}

/**
 * The decoded JSON is never trusted: `s` must be this request's sort, `id` a string and `v`
 * a scalar of the sort field's type. That stops a crafted cursor carrying an operator object
 * into the filter.
 */
function decodeCursor(
	raw: string,
	spec: string,
	type: FieldType,
): { v: Scalar; id: string } {
	if (raw.length > MAX_CURSOR_LENGTH || !BASE64URL.test(raw)) {
		throw new ListQueryError("bad_cursor");
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
	} catch {
		throw new ListQueryError("bad_cursor");
	}
	if (
		!isRecord(decoded) ||
		Object.keys(decoded).sort().join() !== "id,s,v" ||
		decoded.s !== spec ||
		typeof decoded.id !== "string" ||
		!cursorValueOk(type, decoded.v)
	) {
		throw new ListQueryError("bad_cursor");
	}
	return { v: decoded.v, id: decoded.id };
}

/** Builds the typed query from the raw querystring object, or throws a ListQueryError. */
export function parseListQuery(
	query: unknown,
	collection: ListCollection,
): ParsedList {
	if (!isRecord(query)) throw new ListQueryError("bad_query");
	const fields = fieldsOf(collection);
	const filters: ListCondition[] = [];
	let limit = DEFAULT_LIMIT;
	let cursor: string | undefined;
	let sortSpec = DEFAULT_SORT;

	for (const [key, value] of Object.entries(query)) {
		// A repeated key arrives as an array and a bracket syntax may arrive as an object:
		// neither is ever typed, so no client structure reaches MongoDB.
		if (Array.isArray(value)) throw new ListQueryError("repeated_parameter");
		if (typeof value !== "string") throw new ListQueryError("bad_value");

		if (key === "limit") {
			limit = parseLimit(value);
		} else if (key === "cursor") {
			cursor = value;
		} else if (key === "sort") {
			sortSpec = value;
		} else {
			// The operator is the last segment only when it is one of the five names, which
			// no field path may contain, so a path is never misread.
			const dot = key.lastIndexOf(".");
			const suffix = dot === -1 ? "" : key.slice(dot + 1);
			const hasOperator = OPERATORS.has(suffix);
			const op = hasOperator ? (suffix as FilterOp) : "eq";
			const field = fields.get(hasOperator ? key.slice(0, dot) : key);
			if (field === undefined) throw new ListQueryError("unknown_parameter");
			filters.push({
				field: field.mongo,
				op,
				value: typed(field, op, value),
			});
		}
	}

	const dir = sortSpec.startsWith("-") ? -1 : 1;
	const sortField = fields.get(dir === -1 ? sortSpec.slice(1) : sortSpec);
	if (sortField === undefined) throw new ListQueryError("bad_sort");
	const sort = { field: sortField.mongo, dir, spec: sortSpec } as const;
	const after =
		cursor === undefined
			? undefined
			: decodeCursor(cursor, sort.spec, sortField.type);
	return { filters, sort, limit, ...(after === undefined ? {} : { after }) };
}

/** The value of the sort field on a stored record, for the next cursor. */
export function sortValueOf(document: RecordDocument, field: string): unknown {
	if (field === "createdAt") return document.createdAt;
	if (field === "updatedAt") return document.updatedAt;
	let value: unknown = document.data;
	for (const segment of field.slice("data.".length).split(".")) {
		value = isRecord(value) ? value[segment] : undefined;
	}
	return value;
}
