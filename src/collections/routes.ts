import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "mongodb";
import {
	ConfigKeyStore,
	type KeyStore,
	requireGrant,
} from "../auth/api-keys.ts";
import type { Config } from "../config/schema.ts";
import { PROBLEM_JSON, problem } from "../http/logging.ts";
import {
	anonymousRateLimit,
	honeypotFilled,
	originGuard,
	requireMediaType,
} from "./hardening.ts";
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

const JSON_TYPE = "application/json";
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

/**
 * The only reply an anonymous create ever sends, real or honeypot: one function sets
 * status, ETag and body, so the two cannot drift apart. A new record is version 1.
 */
function anonymousCreated(reply: FastifyReply, id: string, createdAt: string) {
	reply.status(201).header("etag", etag(1));
	return { id, createdAt };
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
	// global: false, so only routes that attach a limiter hook are counted.
	app.register(rateLimit, { global: false });

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

				// One hook, so every anonymous route of the collection shares a bucket.
				// It runs before anything else on the route and before the body is parsed.
				const limited = anonymousRateLimit(scope, definition.rateLimit);
				const guard = (operation: string, policy: string) =>
					policy === "apiKey"
						? { onRequest: requireGrant(keyStore, name, operation) }
						: { onRequest: limited };
				// Body routes: credentials or limiter first, then the media type, all before
				// the body is read; Fastify answers 413 itself above bodyLimit.
				const bodyRoute = (
					operation: string,
					policy: string,
					type: string,
				) => ({
					onRequest: [
						guard(operation, policy).onRequest,
						requireMediaType(type),
					],
					bodyLimit: definition.bodyLimit,
				});

				if (operations.create !== undefined) {
					const policy = operations.create;
					scope.post(
						"/",
						bodyRoute("create", policy, JSON_TYPE),
						async (request, reply) => {
							const body = request.body;
							const { honeypot } = definition;
							if (policy === "anonymous" && honeypot !== undefined) {
								// Before validation, so a bot learns nothing from a 400 and the
								// path writes and logs nothing (D-08). A key does not skip it (D-05).
								if (honeypotFilled(body, honeypot)) {
									return anonymousCreated(
										reply,
										randomUUID(),
										new Date().toISOString(),
									);
								}
								// The one stripping exception: an empty or null honeypot.
								if (isPlainObject(body)) delete body[honeypot];
							}
							// Record bodies are validated here, not through route `schema.body`:
							// Fastify's Ajv would coerce and strip them.
							const errors = isPlainObject(body)
								? validate(body)
								: [{ keyword: "type" }];
							if (errors !== null || !isPlainObject(body)) {
								return reject(reply, 400, errors ?? []);
							}
							const created = await store.insert(name, body);
							if (policy === "anonymous") {
								return anonymousCreated(reply, created._id, created.createdAt);
							}
							reply.status(201).header("etag", etag(created._v));
							return toRecord(created);
						},
					);
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
						bodyRoute("replace", operations.replace, JSON_TYPE),
						async (request, reply) => {
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
						bodyRoute("patch", operations.patch, MERGE_PATCH),
						async (request, reply) => {
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
