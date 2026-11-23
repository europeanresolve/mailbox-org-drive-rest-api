import type { FastifyInstance } from "fastify";
import { type KeyStore, requireGrant } from "../auth/api-keys.ts";
import { PROBLEM_JSON, problem } from "../http/logging.ts";
import type { MirrorStateStore } from "./state.ts";

export function registerMirrorRoutes(
	app: FastifyInstance,
	options: {
		keyStore: KeyStore;
		state: MirrorStateStore;
		names: readonly string[];
	},
): void {
	const configured = new Set(options.names);

	app.get(
		"/mirror/status",
		{ onRequest: requireGrant(options.keyStore, "mirror", "status") },
		async (_request, reply) => {
			const collections = await options.state.status(options.names, new Date());
			return reply.header("cache-control", "no-store").send({ collections });
		},
	);

	app.post(
		"/mirror",
		{ onRequest: requireGrant(options.keyStore, "mirror", "rebuild") },
		async (request, reply) => {
			const query = request.query as { collection?: string };
			let targets: string[];
			if (query.collection === undefined) {
				targets = [...options.names];
			} else {
				if (!configured.has(query.collection)) {
					return reply.status(404).type(PROBLEM_JSON).send(problem(404));
				}
				targets = [query.collection];
			}
			await options.state.requestRebuild(targets);
			return reply
				.status(202)
				.send({ status: "accepted", collections: targets });
		},
	);
}
