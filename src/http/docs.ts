import { readFileSync } from "node:fs";
import { STATUS_CODES } from "node:http";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance } from "fastify";
import {
	FILTER_OPERATORS,
	resolveIndexPath,
} from "../collections/definition.ts";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../collections/list-query.ts";
import type {
	CollectionOperation,
	CollectionPolicy,
	Config,
} from "../config/schema.ts";

type Json = Record<string, unknown>;
type CollectionConfig = Config["collections"][string];

const SCHEMAS = "#/components/schemas/";
const JSON_TYPE = "application/json";
const MERGE_PATCH = "application/merge-patch+json";
const PROBLEM_TYPE = "application/problem+json";

function version(): string {
	try {
		const raw = readFileSync(
			new URL("../../package.json", import.meta.url),
			"utf8",
		);
		const { version } = JSON.parse(raw) as { version?: unknown };
		return typeof version === "string" ? version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}

const ref = (name: string): Json => ({ $ref: `${SCHEMAS}${name}` });

/** OpenAPI component keys cannot contain `/`; collection routes and paths keep slashes. */
function componentBase(name: string): string {
	return name.replaceAll("/", "_");
}

/** Keywords whose value is data, not schema: a `$ref` key inside is not a reference. */
const DATA_KEYWORDS: ReadonlySet<string> = new Set([
	"enum",
	"const",
	"default",
	"examples",
	"example",
]);

/**
 * Deep copy of a collection schema with every internal reference (`#`, `#/$defs/x`)
 * pointed inside the component that now holds it, so the published document resolves.
 */
function rewriteRefs(node: unknown, base: string): unknown {
	if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, base));
	if (typeof node !== "object" || node === null) return node;
	const copy: Json = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "$ref" && typeof value === "string" && value.startsWith("#")) {
			copy[key] = `${base}${value.slice(1)}`;
		} else if (DATA_KEYWORDS.has(key)) {
			copy[key] = structuredClone(value);
		} else {
			copy[key] = rewriteRefs(value, base);
		}
	}
	return copy;
}

const ID_FIELDS: Json = {
	id: { type: "string", format: "uuid" },
	createdAt: { type: "string", format: "date-time" },
	updatedAt: { type: "string", format: "date-time" },
};

/** `<name>.record`: the input schema with the server fields declared next to the user's. */
function recordSchema(input: Json): Json {
	const { $defs: _defs, $id: _id, ...rest } = input;
	const properties = (rest.properties ?? {}) as Json;
	const required = Array.isArray(rest.required) ? rest.required : [];
	return {
		...rest,
		properties: { ...properties, ...ID_FIELDS },
		required: [...required, "id", "createdAt", "updatedAt"],
	};
}

function collectionSchemas(name: string, collection: CollectionConfig): Json {
	const base = componentBase(name);
	const input = rewriteRefs(
		collection.schema,
		`${SCHEMAS}${base}.input`,
	) as Json;
	return {
		[`${base}.input`]: input,
		[`${base}.record`]: recordSchema(input),
		[`${base}.page`]: {
			type: "object",
			additionalProperties: false,
			required: ["items", "nextCursor"],
			properties: {
				items: { type: "array", items: ref(`${base}.record`) },
				nextCursor: {
					type: ["string", "null"],
					description: "Pass as `cursor` for the next page; null on the last.",
				},
			},
		},
	};
}

const SHARED_SCHEMAS: Json = {
	AnonymousCreated: {
		type: "object",
		additionalProperties: false,
		required: ["id", "createdAt"],
		properties: {
			id: ID_FIELDS.id,
			createdAt: ID_FIELDS.createdAt,
		},
	},
	Problem: {
		type: "object",
		required: ["type", "title", "status"],
		properties: {
			type: { type: "string" },
			title: { type: "string" },
			status: { type: "integer" },
			errors: {
				type: "array",
				description:
					"Keywords and safe pointers only; never a submitted value.",
				items: {
					type: "object",
					required: ["keyword"],
					properties: {
						keyword: { type: "string" },
						pointer: { type: "string" },
					},
				},
			},
		},
	},
};

const ERROR_NOTES: Record<number, string> = {
	400: "The body or query is invalid; `errors` lists keywords and pointers, never values.",
	401: "Missing or unknown API key.",
	403: "The API key lacks the grant, or the Origin is not on the collection's allow-list.",
	404: "No such record.",
	409: "A request with the same Idempotency-Key is still in flight, or the record kept changing under a PATCH.",
	412: "If-Match does not match the record's current ETag.",
	413: "The body is over the collection's `bodyLimit`.",
	415: "Wrong Content-Type for this operation.",
	422: "The Idempotency-Key was used before with another body or another API key.",
	429: "Per-IP rate limit exceeded; see Retry-After.",
};

function problemResponse(status: number, note?: string): Json {
	const response: Json = {
		description:
			`${STATUS_CODES[status] ?? "Error"}. ${note ?? ERROR_NOTES[status] ?? ""}`.trim(),
		content: { [PROBLEM_TYPE]: { schema: ref("Problem") } },
	};
	if (status === 429) {
		response.headers = {
			"Retry-After": {
				description: "Seconds until the client may retry.",
				schema: { type: "integer" },
			},
		};
	}
	return response;
}

const ETAG_HEADER: Json = {
	ETag: {
		description: "The record's version as a strong entity tag.",
		schema: { type: "string" },
	},
};

const successJson = (description: string, schema: Json): Json => ({
	description,
	headers: ETAG_HEADER,
	content: { [JSON_TYPE]: { schema } },
});

const header = (
	name: string,
	description: string,
	schema: Json,
	required = false,
): Json => ({ name, in: "header", required, description, schema });

const ID_PARAMETER: Json = {
	name: "id",
	in: "path",
	required: true,
	description: "The record id returned by create.",
	schema: { type: "string" },
};

const IF_MATCH = header(
	"If-Match",
	'ETag of the version to change, for example `"3"`; `*` matches any. A mismatch gives 412.',
	{ type: "string" },
);

const IDEMPOTENCY_KEY = header(
	"Idempotency-Key",
	"1 to 255 visible ASCII characters. A retry with the same key and body returns the original response and stores no second record; the key is kept for 24 hours and is scoped to the collection.",
	{ type: "string", minLength: 1, maxLength: 255, pattern: "^[\\x21-\\x7e]+$" },
);

const FILTER_TYPES: Record<string, Json> = {
	string: { type: "string" },
	integer: { type: "integer" },
	number: { type: "number" },
	boolean: { type: "boolean" },
	date: { type: "string", format: "date-time" },
};

/** The query parameters of list: paging, sort, and equality and range filters per filterable field. */
function listParameters(collection: CollectionConfig): Json[] {
	const fields: { path: string; type: string }[] = [
		{ path: "createdAt", type: "date" },
		{ path: "updatedAt", type: "date" },
	];
	for (const path of collection.indexes ?? []) {
		const resolved = resolveIndexPath({ ...collection.schema }, path);
		if ("type" in resolved) fields.push({ path, type: resolved.type });
	}
	const query = (name: string, description: string, schema: Json): Json => ({
		name,
		in: "query",
		required: false,
		description,
		schema,
	});
	const parameters: Json[] = [
		query("limit", "Page size.", {
			type: "integer",
			minimum: 1,
			maximum: MAX_LIMIT,
			default: DEFAULT_LIMIT,
		}),
		query("cursor", "`nextCursor` of the previous page.", { type: "string" }),
		query("sort", "Field to order by; a leading `-` reverses it.", {
			type: "string",
			default: "-createdAt",
			enum: fields.flatMap(({ path }) => [path, `-${path}`]),
		}),
	];
	for (const { path, type } of fields) {
		const schema = FILTER_TYPES[type] ?? { type: "string" };
		parameters.push(
			query(path, `Records where ${path} equals the value.`, schema),
		);
		if (type === "boolean") continue;
		for (const op of FILTER_OPERATORS) {
			if (op === "eq") continue;
			parameters.push(
				query(`${path}.${op}`, `Records where ${path} is ${op}.`, schema),
			);
		}
	}
	return parameters;
}

type Operation = {
	method: "get" | "post" | "put" | "patch" | "delete";
	item: boolean;
	summary: string;
};

const OPERATIONS: Record<CollectionOperation, Operation> = {
	create: { method: "post", item: false, summary: "Create a record" },
	list: { method: "get", item: false, summary: "List records" },
	get: { method: "get", item: true, summary: "Read a record" },
	replace: { method: "put", item: true, summary: "Replace a record" },
	patch: { method: "patch", item: true, summary: "Patch a record" },
	delete: { method: "delete", item: true, summary: "Delete a record" },
};

function operationDocument(
	name: string,
	operation: CollectionOperation,
	policy: CollectionPolicy,
	collection: CollectionConfig,
): Json {
	const base = componentBase(name);
	const anonymous = policy === "anonymous";
	const parameters: Json[] = [];
	const responses: Record<string, Json> = {};
	let requestBody: Json | undefined;
	const errors = new Set<number>([403]);

	switch (operation) {
		case "create":
			parameters.push(IDEMPOTENCY_KEY);
			requestBody = {
				required: true,
				content: { [JSON_TYPE]: { schema: ref(`${base}.input`) } },
			};
			responses["201"] = successJson(
				anonymous
					? "Created. Anonymous callers get only the id and creation time."
					: "Created.",
				ref(anonymous ? "AnonymousCreated" : `${base}.record`),
			);
			for (const status of [400, 409, 413, 415, 422]) errors.add(status);
			break;
		case "list":
			parameters.push(...listParameters(collection));
			responses["200"] = {
				description: "One page of records.",
				content: { [JSON_TYPE]: { schema: ref(`${base}.page`) } },
			};
			errors.add(400);
			break;
		case "get":
			parameters.push(ID_PARAMETER);
			responses["200"] = successJson("The record.", ref(`${base}.record`));
			errors.add(404);
			break;
		case "replace":
			parameters.push(ID_PARAMETER, IF_MATCH);
			requestBody = {
				required: true,
				content: { [JSON_TYPE]: { schema: ref(`${base}.input`) } },
			};
			responses["200"] = successJson(
				"The record after the change.",
				ref(`${base}.record`),
			);
			for (const status of [400, 404, 412, 413, 415]) errors.add(status);
			break;
		case "patch":
			parameters.push(ID_PARAMETER, IF_MATCH);
			requestBody = {
				required: true,
				content: {
					[MERGE_PATCH]: {
						schema: {
							type: "object",
							description: `RFC 7386 JSON Merge Patch; the merged record must satisfy ${base}.input.`,
						},
					},
				},
			};
			responses["200"] = successJson(
				"The record after the change.",
				ref(`${base}.record`),
			);
			for (const status of [400, 404, 409, 412, 413, 415]) errors.add(status);
			break;
		case "delete":
			parameters.push(ID_PARAMETER);
			responses["204"] = { description: "Deleted." };
			errors.add(404);
			break;
	}
	if (anonymous) errors.add(429);
	else errors.add(401);
	for (const status of [...errors].sort((a, b) => a - b)) {
		responses[String(status)] = problemResponse(status);
	}

	return {
		tags: [name],
		operationId: `${base}.${operation}`,
		summary: `${OPERATIONS[operation].summary} (${name})`,
		security: anonymous ? [] : [{ bearerAuth: [] }],
		parameters,
		...(requestBody ? { requestBody } : {}),
		responses: Object.fromEntries(
			Object.entries(responses).sort(([a], [b]) => Number(a) - Number(b)),
		),
	};
}

const HEALTH_PATHS: Json = {
	"/health": {
		get: {
			tags: ["operations"],
			operationId: "health",
			summary: "Liveness; depends on nothing",
			security: [],
			responses: {
				"200": {
					description: "The process is up.",
					content: {
						[JSON_TYPE]: {
							schema: {
								type: "object",
								required: ["status"],
								properties: { status: { type: "string", enum: ["ok"] } },
							},
						},
					},
				},
			},
		},
	},
};

const READY_BODY: Json = {
	type: "object",
	required: ["status", "mongo", "drive"],
	properties: {
		status: { type: "string", enum: ["ready", "not-ready"] },
		mongo: { type: "string", enum: ["up", "down"] },
		drive: {
			type: "string",
			enum: ["unknown", "up", "degraded", "unavailable"],
		},
	},
};

const MIRROR_STATUS_FIELDS: Json = {
	name: { type: "string" },
	lastMirroredAt: {
		type: ["string", "null"],
		format: "date-time",
	},
	lagSeconds: { type: "integer" },
	pendingWrites: { type: "integer" },
	failures: { type: "integer" },
	lastError: {
		type: ["string", "null"],
		description:
			"Drive or workbook error code; no record values or mount paths.",
	},
	nextAttemptAt: {
		type: ["string", "null"],
		format: "date-time",
	},
	externalChangeAt: {
		type: ["string", "null"],
		format: "date-time",
	},
	externalChanges: { type: "integer" },
};

function mirrorPaths(): Json {
	return {
		"/mirror/status": {
			get: {
				tags: ["operations"],
				operationId: "mirror.status",
				summary: "Mirror health per collection",
				security: [{ bearerAuth: [] }],
				responses: {
					"200": {
						description: "Mirror state; no record values.",
						content: {
							[JSON_TYPE]: {
								schema: {
									type: "object",
									additionalProperties: false,
									required: ["collections"],
									properties: {
										collections: {
											type: "array",
											items: ref("MirrorStatus"),
										},
									},
								},
							},
						},
					},
					"401": problemResponse(401),
					"403": problemResponse(403),
				},
			},
		},
		"/mirror": {
			post: {
				tags: ["operations"],
				operationId: "mirror.rebuild",
				summary: "Force mirror regeneration",
				security: [{ bearerAuth: [] }],
				parameters: [
					{
						name: "collection",
						in: "query",
						required: false,
						description:
							"Collection to rebuild; omit to rebuild every collection.",
						schema: { type: "string" },
					},
				],
				responses: {
					"202": {
						description: "Rebuild scheduled.",
						content: {
							[JSON_TYPE]: {
								schema: {
									type: "object",
									required: ["status", "collections"],
									properties: {
										status: { type: "string", enum: ["accepted"] },
										collections: {
											type: "array",
											items: { type: "string" },
										},
									},
								},
							},
						},
					},
					"401": problemResponse(401),
					"403": problemResponse(403),
					"404": problemResponse(404, "Unknown collection name."),
				},
			},
		},
	};
}

const READY_PATHS: Json = {
	"/ready": {
		get: {
			tags: ["operations"],
			operationId: "ready",
			summary: "Readiness; fails only when MongoDB is down",
			security: [],
			responses: {
				"200": {
					description: "MongoDB is up; `drive` reports the Drive state.",
					content: { [JSON_TYPE]: { schema: READY_BODY } },
				},
				"503": {
					description: "MongoDB is down.",
					content: { [JSON_TYPE]: { schema: READY_BODY } },
				},
			},
		},
	},
};

function collectionPaths(name: string, collection: CollectionConfig): Json {
	const paths: Record<string, Record<string, Json>> = {};
	for (const operation of Object.keys(OPERATIONS) as CollectionOperation[]) {
		const policy = collection.operations[operation];
		if (policy === undefined) continue;
		const { method, item } = OPERATIONS[operation];
		const url = item ? `/v1/${name}/{id}` : `/v1/${name}`;
		const entry = paths[url] ?? {};
		entry[method] = operationDocument(name, operation, policy, collection);
		paths[url] = entry;
	}
	return paths;
}

/**
 * OpenAPI 3.1 document at /docs/json and UI at /docs (FND-04). Collection routes
 * carry no Fastify route schemas (validation happens in the handlers, so no
 * serializer or coercion is switched on). The whole `paths` object is built here from
 * config, so the document cannot drift from what the config allows. `ready` says
 * whether /ready is registered.
 */
export function registerDocs(
	app: FastifyInstance,
	config: Config,
	options: { ready?: boolean } = {},
): void {
	const schemas: Json = {};
	const paths: Json = {
		...HEALTH_PATHS,
		...(options.ready ? READY_PATHS : {}),
	};
	if (config.mirror !== undefined) {
		Object.assign(paths, mirrorPaths());
	}
	for (const [name, collection] of Object.entries(config.collections)) {
		Object.assign(schemas, collectionSchemas(name, collection));
		Object.assign(paths, collectionPaths(name, collection));
	}
	if (config.mirror !== undefined) {
		schemas.MirrorStatus = {
			type: "object",
			additionalProperties: false,
			required: [
				"name",
				"lastMirroredAt",
				"lagSeconds",
				"pendingWrites",
				"failures",
				"lastError",
				"nextAttemptAt",
				"externalChangeAt",
				"externalChanges",
			],
			properties: MIRROR_STATUS_FIELDS,
		};
	}
	Object.assign(schemas, SHARED_SCHEMAS);

	app.register(swagger, {
		openapi: {
			openapi: "3.1.0",
			info: { title: "mailbox-org-drive-rest-api", version: version() },
			components: {
				securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
			},
		},
		// No route documents itself: collection routes have no Fastify schemas, and the
		// CORS preflights, trailing-slash twins and the UI must not appear at all.
		transform: ({ url }: { url: string }) => ({ schema: { hide: true }, url }),
		transformObject: ({ openapiObject }: { openapiObject: Json }) => ({
			...openapiObject,
			paths,
			components: { ...(openapiObject.components as Json), schemas },
		}),
	} as never);
	app.register(swaggerUi, { routePrefix: "/docs" });
}
