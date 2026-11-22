import type { FastifyReply, FastifyRequest } from "fastify";
import { PROBLEM_JSON, problem } from "../http/logging.ts";

/**
 * onRequest hook for one collection's browser origin allow-list (D-12).
 * No Origin header (a server, curl) passes; any other value that is not an exact
 * member of `origins`, `null` included, gets 403 before the body is parsed.
 * The reply carries fixed text only: the origin is never echoed or logged.
 */
export function originGuard(origins: readonly string[]) {
	const allowed = new Set(origins);
	return async (request: FastifyRequest, reply: FastifyReply) => {
		const origin = request.headers.origin;
		if (origin === undefined || allowed.has(origin)) return;
		return reply.status(403).type(PROBLEM_JSON).send(problem(403));
	};
}
