import type { ErrorObject } from "ajv/dist/2020.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Config } from "../config/schema.ts";

/** One validation failure as it is shown to a client: a keyword and, when safe, a pointer. */
export type ProblemEntry = { keyword: string; pointer?: string };

/** Returns null when `data` is valid, else value-free problem entries. */
export type RecordValidator = (data: unknown) => ProblemEntry[] | null;

/**
 * Strict by construction. Fastify's own Ajv coerces, strips and fills defaults;
 * a stored record must be exactly what the client sent and the schema allows.
 * No loadSchema: a remote or external $ref cannot load and fails compilation.
 */
export function createRecordAjv(): Ajv2020 {
	const ajv = new Ajv2020({
		strict: true,
		allErrors: false,
		coerceTypes: false,
		removeAdditional: false,
		useDefaults: false,
	});
	// ajv-formats is CommonJS; under NodeNext the import is the module object
	// and the plugin is its `default` (also set at runtime).
	addFormats.default(ajv);
	return ajv;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every property name the deployer declared anywhere in the schema. */
function declaredNames(schema: unknown, into = new Set<string>()): Set<string> {
	if (Array.isArray(schema)) {
		for (const item of schema) declaredNames(item, into);
	} else if (isRecord(schema)) {
		for (const [keyword, value] of Object.entries(schema)) {
			if (keyword === "properties" && isRecord(value)) {
				for (const name of Object.keys(value)) into.add(name);
			}
			declaredNames(value, into);
		}
	}
	return into;
}

function unescapeSegment(segment: string): string {
	return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

/**
 * The instance path, kept only when every segment is an array index into a real
 * array or a property name the schema declares. Anything else could be a name
 * the client chose, so no pointer is returned.
 */
function safePointer(
	path: string,
	data: unknown,
	declared: ReadonlySet<string>,
): string | undefined {
	if (path === "") return undefined;
	let node: unknown = data;
	for (const raw of path.slice(1).split("/")) {
		const segment = unescapeSegment(raw);
		if (Array.isArray(node)) {
			if (!/^\d+$/.test(segment)) return undefined;
			node = node[Number(segment)];
		} else if (isRecord(node) && declared.has(segment)) {
			node = node[segment];
		} else {
			return undefined;
		}
	}
	return path;
}

/** Never copies Ajv's message, data or params: they hold submitted values. */
export function problemEntries(
	errors: readonly ErrorObject[],
	data: unknown,
	declared: ReadonlySet<string>,
): ProblemEntry[] {
	return errors.map((error) => {
		const pointer = safePointer(error.instancePath, data, declared);
		return pointer === undefined
			? { keyword: error.keyword }
			: { keyword: error.keyword, pointer };
	});
}

/** Compiles every collection schema once, at boot, never per request. */
export function compileCollections(
	collections: Config["collections"],
	ajv: Ajv2020 = createRecordAjv(),
): ReadonlyMap<string, RecordValidator> {
	const compiled = new Map<string, RecordValidator>();
	for (const [name, definition] of Object.entries(collections)) {
		const validate = ajv.compile(definition.schema);
		const declared = declaredNames(definition.schema);
		compiled.set(name, (data) => {
			if (validate(data)) return null;
			return problemEntries(validate.errors ?? [], data, declared);
		});
	}
	return compiled;
}
