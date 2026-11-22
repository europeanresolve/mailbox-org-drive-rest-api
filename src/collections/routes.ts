import cors from "@fastify/cors";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "mongodb";
import {
	ConfigKeyStore,
	type KeyStore,
	requireGrant,
} from "../auth/api-keys.ts";
import type { Config } from "../config/schema.ts";
import { PROBLEM_JSON, problem } from "../http/logging.ts";
import { originGuard } from "./hardening.ts";
import { parseIfMatch } from "./if-match.ts";
import {
	encodeCursor,
	ListQueryError,
	parseListQuery,
	sortValueOf,
} from "./list-query.ts";
import { applyMergePatch } from "./merge-patch.ts";
import { type RecordDocument, RecordStore } from "./store.ts";
import { compileCollections } from "./validator.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{ id, createdAt, updatedAt, ...data }`; server fields come last so user data cannot shadow them. */
function toRecord(document: RecordDocument): Record<string, unknown> {
	return {
		...document.data,
		id: document._id,
		createdAt: document.createdAt,
		updatedAt: document.updatedAt,
	};
}

/** Fixed-text problem+json; `errors` carry keywords and safe pointers only. */
function reject(
	reply: FastifyReply,
	status: number,
	errors?: readonly { keyword: string; pointer?: string }[],
) {
	return reply.status(status).type(PROBLEM_JSON).send(problem(status, errors));
}

const MERGE_PATCH = "application/merge-patch+json";
/** Total attempts for a PATCH that keeps losing the version race (D-20). */
const PATCH_ATTEMPTS = 3;

/** The HTTP method each operation registers; what a preflight may announce. */
const OPERATION_METHOD = {
	create: "POST",
	list: "GET",
	get: "GET",
	replace: "PUT",
	patch: "PATCH",
	delete: "DELETE",
} as const;

const etag = (version: number): string => `"${version}"`;

/** The media type without parameters, lower-cased; "" when the header is absent. */
function mediaType(request: FastifyRequest): string {
	const [type = ""] = (request.headers["content-type"] ?? "").split(";");
	return type.trim().toLowerCase();
}

/**
 * One encapsulated plugin per collection at /v1/{name} (D-15). An operation with
 * no policy is never registered, so it answers the normal 404 (D-03).
 */
export function registerCollections(
	app: FastifyInstance,
	options: { config: Config; db: Db; keyStore?: KeyStore },
): void {
	const { config, db } = options;
	const keyStore = options.keyStore ?? new ConfigKeyStore(config.apiKeys);
	const validators = compileCollections(config.collections);
	const store = new RecordStore(db);

	for (const [name, definition] of Object.entries(config.collections)) {
		const validate = validators.get(name);
		if (validate === undefined) continue;
		const { operations } = definition;

		app.register(
			async (scope) => {
				// Before any route, so it also covers the preflight route (D-12).
				scope.addHook("onRequest", originGuard(definition.cors?.origins ?? []));
				await scope.register(cors, {
					origin: [...(definition.cors?.origins ?? [])],
					methods: [
						...new Set(
							Object.keys(operations).map(
								(op) => OPERATION_METHOD[op as keyof typeof OPERATION_METHOD],
							),
						),
					],
					allowedHeaders: [
						"Content-Type",
						"Authorization",
						"Idempotency-Key",
						"If-Match",
					],
					exposedHeaders: ["ETag", "Retry-After"],
					credentials: false,
					maxAge: 600,
				});

				const guard = (operation: string, policy: string) =>
					policy === "apiKey"
						? { onRequest: requireGrant(keyStore, name, operation) }
						: {};

				if (operations.create !== undefined) {
					const policy = operations.create;
					scope.post("/", guard("create", policy), async (request, reply) => {
						const body = request.body;
						// Record bodies are validated here, not through route `schema.body`:
						// Fastify's Ajv would coerce and strip them.
						const errors = isPlainObject(body)
							? validate(body)
							: [{ keyword: "type" }];
						if (errors !== null || !isPlainObject(body)) {
							return reject(reply, 400, errors ?? []);
						}
						const created = await store.insert(name, body);
						reply.status(201).header("etag", etag(created._v));
						return policy === "anonymous"
							? { id: created._id, createdAt: created.createdAt }
							: toRecord(created);
					});
				}

				if (operations.list !== undefined) {
					scope.get(
						"/",
						guard("list", operations.list),
						async (request, reply) => {
							let parsed: ReturnType<typeof parseListQuery>;
							try {
								parsed = parseListQuery(request.query, definition);
							} catch (error) {
								if (!(error instanceof ListQueryError)) throw error;
								// The code is fixed text; nothing from the query comes back.
								return reject(reply, 400, [{ keyword: error.code }]);
							}
							const { items, hasMore } = await store.list(name, parsed);
							const last = items.at(-1);
							return {
								items: items.map(toRecord),
								nextCursor:
									hasMore && last !== undefined
										? encodeCursor({
												s: parsed.sort.spec,
												v: sortValueOf(last, parsed.sort.field),
												id: last._id,
											})
										: null,
							};
						},
					);
				}

				if (operations.get !== undefined) {
					scope.get<{ Params: { id: string } }>(
						"/:id",
						guard("get", operations.get),
						async (request, reply) => {
							const found = await store.findById(name, request.params.id);
							if (found === null) {
								return reject(reply, 404);
							}
							reply.header("etag", etag(found._v));
							return toRecord(found);
						},
					);
				}

				if (operations.replace !== undefined) {
					scope.put<{ Params: { id: string } }>(
						"/:id",
						guard("replace", operations.replace),
						async (request, reply) => {
							if (mediaType(request) !== "application/json") {
								return reject(reply, 415);
							}
							const body = request.body;
							const errors = isPlainObject(body)
								? validate(body)
								: [{ keyword: "type" }];
							if (errors !== null || !isPlainObject(body)) {
								return reject(reply, 400, errors ?? []);
							}
							const match = parseIfMatch(request.headers["if-match"]);
							const { id } = request.params;
							const updated = await store.replace(
								name,
								id,
								body,
								match === undefined || "any" in match
									? undefined
									: match.versions,
							);
							if (updated === null) {
								// One follow-up read tells a missing id from a stale version.
								const exists = await store.findById(name, id);
								return reject(reply, exists === null ? 404 : 412);
							}
							reply.header("etag", etag(updated._v));
							return toRecord(updated);
						},
					);
				}

				if (operations.patch !== undefined) {
					// The default JSON parser with both poisoning actions set to "error"
					// rejects __proto__ and constructor.prototype keys, as for application/json.
					scope.addContentTypeParser(
						MERGE_PATCH,
						{ parseAs: "string" },
						scope.getDefaultJsonParser("error", "error"),
					);
					scope.patch<{ Params: { id: string } }>(
						"/:id",
						guard("patch", operations.patch),
						async (request, reply) => {
							if (mediaType(request) !== MERGE_PATCH) {
								return reject(reply, 415);
							}
							const patch = request.body;
							if (!isPlainObject(patch)) {
								return reject(reply, 400, [{ keyword: "type" }]);
							}
							const match = parseIfMatch(request.headers["if-match"]);
							const { id } = request.params;
							for (let attempt = 0; attempt < PATCH_ATTEMPTS; attempt++) {
								const current = await store.findById(name, id);
								if (current === null) {
									return reject(reply, 404);
								}
								if (
									match !== undefined &&
									!("any" in match) &&
									!match.versions.includes(current._v)
								) {
									return reject(reply, 412);
								}
								const merged = applyMergePatch(current.data, patch);
								const errors = isPlainObject(merged)
									? validate(merged)
									: [{ keyword: "type" }];
								if (errors !== null || !isPlainObject(merged)) {
									return reject(reply, 400, errors ?? []);
								}
								// Filtered on the version just read, so another writer's fields are
								// never overwritten: a miss means re-read and merge again.
								const updated = await store.replace(name, id, merged, [
									current._v,
								]);
								if (updated !== null) {
									reply.header("etag", etag(updated._v));
									return toRecord(updated);
								}
							}
							return reject(reply, 409);
						},
					);
				}

				if (operations.delete !== undefined) {
					scope.delete<{ Params: { id: string } }>(
						"/:id",
						guard("delete", operations.delete),
						async (request, reply) => {
							const removed = await store.remove(name, request.params.id);
							if (!removed) {
								return reject(reply, 404);
							}
							return reply.status(204).send();
						},
					);
				}
			},
			{ prefix: `/v1/${name}` },
		);
	}
}
