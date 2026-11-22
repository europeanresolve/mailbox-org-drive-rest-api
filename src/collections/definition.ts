import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import type { ConfigIssue } from "../config/load.ts";
import { COLLECTION_OPERATIONS, MOUNT_NAME_PATTERN } from "../config/schema.ts";
import { createRecordAjv } from "./validator.ts";

/** D-16 list plus `v1`: names that would shadow a fixed route or a later feature. */
export const RESERVED_COLLECTION_NAMES: ReadonlySet<string> = new Set([
	"files",
	"sheets",
	"documents",
	"mirror",
	"admin",
	"docs",
	"health",
	"ready",
	"v1",
]);

/** Server-owned fields; a user property of the same name would be shadowed in every response. */
const RESERVED_PROPERTIES: ReadonlySet<string> = new Set([
	"id",
	"createdAt",
	"updatedAt",
]);

const NAME = new RegExp(MOUNT_NAME_PATTERN);
const OPERATIONS: ReadonlySet<string> = new Set(COLLECTION_OPERATIONS);

// Issues carry codes and JSON pointers only, never a config value (T-01-16).

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(segment: string | number): string {
	return `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

// --- sibling-file $ref -------------------------------------------------------

type RefResult =
	| { schema: Record<string, unknown> }
	| {
			code:
				| "collection.SCHEMA_REF_OUTSIDE"
				| "collection.SCHEMA_REF_UNREADABLE"
				| "collection.SCHEMA_REF_INVALID";
	  };

function inside(directory: string, path: string): boolean {
	const rel = relative(directory, path);
	return (
		rel !== "" &&
		rel !== ".." &&
		!rel.startsWith(`..${sep}`) &&
		!isAbsolute(rel)
	);
}

function loadRef(ref: string, configDir: string): RefResult {
	if (isAbsolute(ref)) return { code: "collection.SCHEMA_REF_OUTSIDE" };
	const full = resolve(configDir, ref);
	if (!inside(configDir, full))
		return { code: "collection.SCHEMA_REF_OUTSIDE" };

	let text: string;
	try {
		// A symlink inside the directory must not lead out of it.
		if (!inside(realpathSync(configDir), realpathSync(full))) {
			return { code: "collection.SCHEMA_REF_OUTSIDE" };
		}
		text = readFileSync(full, "utf8");
	} catch {
		return { code: "collection.SCHEMA_REF_UNREADABLE" };
	}

	// The yaml package reads JSON too. Its message embeds source text, so it is never used.
	const parsed = parseDocument(text);
	if (parsed.errors.length > 0)
		return { code: "collection.SCHEMA_REF_INVALID" };
	const value: unknown = parsed.toJS();
	if (!isRecord(value)) return { code: "collection.SCHEMA_REF_INVALID" };
	return { schema: value };
}

/**
 * Replaces every collection `schema` that is exactly `{ $ref: "<file>" }` with the
 * parsed content of that file. Refs inside the loaded schema are not followed:
 * strict Ajv has no loadSchema, so an external ref fails as SCHEMA_INVALID.
 * `failed` holds the pointers of schemas that could not be loaded.
 */
export function resolveSchemaRefs(
	document: unknown,
	configDir: string,
): { document: unknown; issues: ConfigIssue[]; failed: Set<string> } {
	const issues: ConfigIssue[] = [];
	const failed = new Set<string>();
	if (!isRecord(document) || !isRecord(document.collections)) {
		return { document, issues, failed };
	}
	const entries = Object.entries(document.collections).map(
		([name, entry]): [string, unknown] => {
			const schema = isRecord(entry) ? entry.schema : undefined;
			if (
				!isRecord(entry) ||
				!isRecord(schema) ||
				typeof schema.$ref !== "string" ||
				Object.keys(schema).length !== 1
			) {
				return [name, entry];
			}
			const at = `/collections${pointer(name)}/schema`;
			const loaded = loadRef(schema.$ref, configDir);
			if ("code" in loaded) {
				issues.push({ code: loaded.code, at });
				failed.add(at);
				return [name, entry];
			}
			return [name, { ...entry, schema: loaded.schema }];
		},
	);
	return {
		document: { ...document, collections: Object.fromEntries(entries) },
		issues,
		failed,
	};
}

// --- schema walk -------------------------------------------------------------

const SCHEMA_MAPS = [
	"properties",
	"patternProperties",
	"$defs",
	"definitions",
	"dependentSchemas",
] as const;
const SCHEMA_LISTS = ["prefixItems", "anyOf", "oneOf", "allOf"] as const;
const SCHEMA_SINGLE = [
	"items",
	"not",
	"if",
	"then",
	"else",
	"contains",
	"additionalProperties",
	"unevaluatedProperties",
	"unevaluatedItems",
	"propertyNames",
] as const;

/** Every direct subschema of `node` with its JSON pointer. */
function* subschemas(
	node: Record<string, unknown>,
	at: string,
): Generator<[unknown, string]> {
	for (const keyword of SCHEMA_MAPS) {
		const map = node[keyword];
		if (!isRecord(map)) continue;
		for (const [key, child] of Object.entries(map)) {
			yield [child, `${at}${pointer(keyword)}${pointer(key)}`];
		}
	}
	for (const keyword of SCHEMA_LISTS) {
		const list = node[keyword];
		if (!Array.isArray(list)) continue;
		for (const [index, child] of list.entries()) {
			yield [child, `${at}${pointer(keyword)}${pointer(index)}`];
		}
	}
	for (const keyword of SCHEMA_SINGLE) {
		const child = node[keyword];
		if (Array.isArray(child)) {
			for (const [index, item] of child.entries()) {
				yield [item, `${at}${pointer(keyword)}${pointer(index)}`];
			}
		} else if (isRecord(child)) {
			yield [child, `${at}${pointer(keyword)}`];
		}
	}
}

/** A field name that cannot be stored safely under `data` in MongoDB. */
function unsafeName(name: string): boolean {
	return (
		name === "" ||
		name.includes(".") ||
		name.startsWith("$") ||
		name.startsWith("_")
	);
}

function walk(
	node: unknown,
	at: string,
	isRoot: boolean,
	report: (issue: ConfigIssue) => void,
): void {
	if (!isRecord(node)) return;
	const properties = isRecord(node.properties) ? node.properties : undefined;
	// Every object schema that declares properties is closed, so no undeclared field is stored.
	if (
		(isRoot || properties !== undefined) &&
		node.additionalProperties !== false
	) {
		report({ code: "collection.NOT_CLOSED", at });
	}
	if (properties !== undefined) {
		for (const name of Object.keys(properties)) {
			const propertyAt = `${at}/properties${pointer(name)}`;
			if (isRoot && RESERVED_PROPERTIES.has(name)) {
				report({ code: "collection.RESERVED_PROPERTY", at: propertyAt });
			}
			if (unsafeName(name)) {
				report({ code: "collection.INVALID_PROPERTY_NAME", at: propertyAt });
			}
		}
	}
	for (const [child, childAt] of subschemas(node, at)) {
		walk(child, childAt, false, report);
	}
}

// --- startup checks ----------------------------------------------------------

export function collectionIssues(
	document: unknown,
	failed: ReadonlySet<string>,
): ConfigIssue[] {
	if (!isRecord(document) || !isRecord(document.collections)) return [];
	const issues: ConfigIssue[] = [];
	const seen = new Set<string>();
	const report = (issue: ConfigIssue): void => {
		const key = `${issue.code} ${issue.at}`;
		if (seen.has(key)) return;
		seen.add(key);
		issues.push(issue);
	};

	for (const [name, entry] of Object.entries(document.collections)) {
		// A bad name or shape was already reported by the schema stage.
		if (!NAME.test(name) || !isRecord(entry)) continue;
		const base = `/collections${pointer(name)}`;
		if (RESERVED_COLLECTION_NAMES.has(name)) {
			report({ code: "collection.RESERVED_NAME", at: base });
		}

		const schema = entry.schema;
		const schemaAt = `${base}/schema`;
		if (!isRecord(schema) || failed.has(schemaAt)) continue;

		try {
			createRecordAjv().compile(schema);
		} catch {
			// Ajv's message can quote the schema; the pointer is all a deployer needs.
			report({ code: "collection.SCHEMA_INVALID", at: schemaAt });
			continue;
		}
		if (schema.type !== "object") {
			report({ code: "collection.NOT_OBJECT", at: schemaAt });
			continue;
		}
		walk(schema, schemaAt, true, report);
	}
	return issues;
}

export function apiKeyIssues(
	document: unknown,
	failed: ReadonlySet<string>,
): ConfigIssue[] {
	if (!isRecord(document) || !Array.isArray(document.apiKeys)) return [];
	const collections = new Set(
		isRecord(document.collections)
			? Object.keys(document.collections).filter((name) => NAME.test(name))
			: [],
	);
	const issues: ConfigIssue[] = [];
	const names = new Set<string>();
	const hashes = new Set<string>();

	for (const [index, key] of document.apiKeys.entries()) {
		if (!isRecord(key)) continue;
		const base = `/apiKeys${pointer(index)}`;

		if (typeof key.name === "string" && NAME.test(key.name)) {
			if (names.has(key.name)) {
				issues.push({ code: "apiKey.DUPLICATE_NAME", at: `${base}/name` });
			}
			names.add(key.name);
		}
		if (
			typeof key.hash === "string" &&
			/^[0-9a-f]{64}$/.test(key.hash) &&
			!failed.has(`${base}/hash`)
		) {
			if (hashes.has(key.hash)) {
				issues.push({ code: "apiKey.DUPLICATE_HASH", at: `${base}/hash` });
			}
			hashes.add(key.hash);
		}

		if (!Array.isArray(key.grants)) continue;
		for (const [grantIndex, grant] of key.grants.entries()) {
			if (typeof grant !== "string" || grant === "") continue;
			const at = `${base}/grants${pointer(grantIndex)}`;
			const colon = grant.indexOf(":");
			const collection = grant.slice(0, colon);
			const operation = grant.slice(colon + 1);
			// Exact `collection:operation` only; a wildcard or a stray colon is malformed (D-02).
			if (
				colon <= 0 ||
				operation === "" ||
				grant.includes("*") ||
				operation.includes(":")
			) {
				issues.push({ code: "apiKey.INVALID_GRANT", at });
			} else if (!collections.has(collection) || !OPERATIONS.has(operation)) {
				issues.push({ code: "apiKey.UNKNOWN_GRANT", at });
			}
		}
	}
	return issues;
}
