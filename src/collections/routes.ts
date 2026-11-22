import type { FastifyInstance } from "fastify";
import type { Db } from "mongodb";
import {
	ConfigKeyStore,
	type KeyStore,
	requireGrant,
} from "../auth/api-keys.ts";
import type { Config } from "../config/schema.ts";
import { PROBLEM_JSON, problem } from "../http/logging.ts";
import {
	encodeCursor,
	ListQueryError,
	parseListQuery,
	sortValueOf,
} from "./list-query.ts";
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

const etag = (version: number): string => `"${version}"`;

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
							return reply
								.status(400)
								.type(PROBLEM_JSON)
								.send(problem(400, errors ?? []));
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
								return reply
									.status(400)
									.type(PROBLEM_JSON)
									.send(problem(400, [{ keyword: error.code }]));
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
								return reply.status(404).type(PROBLEM_JSON).send(problem(404));
							}
							reply.header("etag", etag(found._v));
							return toRecord(found);
						},
					);
				}
			},
			{ prefix: `/v1/${name}` },
		);
	}
}
