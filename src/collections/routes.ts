import { randomUUID } from "node:crypto";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Db } from "mongodb";
import {
	ConfigKeyStore,
	type KeyStore,
	principalOf,
	requireGrant,
} from "../auth/api-keys.ts";
import type { Config } from "../config/schema.ts";
import { PROBLEM_JSON, problem } from "../http/logging.ts";
import type { MirrorStateStore } from "../mirror/state.ts";
import {
	anonymousRateLimit,
	honeypotFilled,
	originGuard,
	requireMediaType,
} from "./hardening.ts";
import {
	canonicalHash,
	IdempotencyStore,
	isDuplicateKey,
	parseIdempotencyKey,
	type StoredResponse,
} from "./idempotency.ts";
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
 * The 201 of a new record. Anonymous callers get only id and createdAt at version 1;
 * the honeypot's fake uses the same builder, so real and fake cannot drift apart.
 */
function anonymousResponse(id: string, createdAt: string): StoredResponse {
	return { status: 201, etag: etag(1), body: { id, createdAt } };
}

function createdResponse(
	policy: string,
	created: RecordDocument,
): StoredResponse {
	return policy === "anonymous"
		? anonymousResponse(created._id, created.createdAt)
		: { status: 201, etag: etag(created._v), body: toRecord(created) };
}

/** The one place a create reply gets its status, ETag and body: real, replayed or fake. */
function sendCreated(reply: FastifyReply, response: StoredResponse) {
	reply.status(response.status).header("etag", response.etag);
	return response.body;
}

/**
 * One encapsulated plugin per collection at /v1/{name} (D-15). An operation with
 * no policy is never registered, so it answers the normal 404 (D-03).
 */
async function markDirtyAfterWrite(
	mirrorState: MirrorStateStore | undefined,
	name: string,
	log: FastifyInstance["log"],
): Promise<void> {
	if (mirrorState === undefined) return;
	await mirrorState.markDirty(name).catch((error: unknown) => {
		log.warn(
			{ collection: name, err: { type: (error as Error).constructor.name } },
			"mirror mark dirty failed",
		);
	});
}

export function registerCollections(
	app: FastifyInstance,
	options: {
		config: Config;
		db: Db;
		keyStore?: KeyStore;
		mirrorState?: MirrorStateStore;
	},
): void {
	const { config, db, mirrorState } = options;
	const keyStore = options.keyStore ?? new ConfigKeyStore(config.apiKeys);
	const validators = compileCollections(config.collections);
	const store = new RecordStore(db);
	const idempotency = new IdempotencyStore(db);
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
									return sendCreated(
										reply,
										anonymousResponse(randomUUID(), new Date().toISOString()),
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
							const rawKey = request.headers["idempotency-key"];
							const key =
								rawKey === undefined ? undefined : parseIdempotencyKey(rawKey);
							if (key === null) {
								return reject(reply, 400, [{ keyword: "idempotencyKey" }]);
							}
							// Without a key: insert and reply. With one: the same, after the
							// idempotency entry has decided whether this request may store.
							let recordId: string | undefined;
							if (key !== undefined) {
								const begun = await idempotency.begin(
									name,
									key,
									// Anonymous routes never read Authorization (D-05).
									policy === "anonymous" ? "anonymous" : principalOf(request),
									canonicalHash(body),
								);
								if (begun.kind === "mismatch") return reject(reply, 422);
								if (begun.kind === "in-flight") return reject(reply, 409);
								if (begun.kind === "replay") {
									return sendCreated(reply, begun.response);
								}
								recordId = begun.recordId;
							}
							let created: RecordDocument;
							try {
								created = await store.insert(name, body, recordId);
							} catch (error) {
								// A duplicate id means an earlier attempt already stored the record.
								const stored =
									recordId !== undefined && isDuplicateKey(error)
										? await store.findById(name, recordId)
										: null;
								if (stored === null) {
									if (key !== undefined) await idempotency.abandon(name, key);
									throw error;
								}
								created = stored;
							}
							const response = createdResponse(policy, created);
							if (key !== undefined) {
								await idempotency.complete(name, key, response);
							}
							await markDirtyAfterWrite(mirrorState, name, scope.log);
							return sendCreated(reply, response);
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
							await markDirtyAfterWrite(mirrorState, name, scope.log);
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
									await markDirtyAfterWrite(mirrorState, name, scope.log);
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
							// The stored create response holds the deleted data (D-13).
							await idempotency.removeForRecord(request.params.id);
							await markDirtyAfterWrite(mirrorState, name, scope.log);
							return reply.status(204).send();
						},
					);
				}
			},
			{ prefix: `/v1/${name}` },
		);
	}
}
