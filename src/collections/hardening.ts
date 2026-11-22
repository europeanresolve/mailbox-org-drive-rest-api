import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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

/**
 * One onRequest hook per collection that counts anonymous requests per client IP
 * (D-11). Each call of `rateLimit(...)` gets its own store, so every anonymous
 * route of one collection shares one bucket and two collections never do. The key
 * is `request.ip`, which already honours the Fastify `trustProxy` list (D-10).
 * The limiter must be registered on `app` with `global: false`. A request over the
 * limit throws a 429 that the app's error handler renders as problem+json; the
 * plugin sets Retry-After first.
 */
export function anonymousRateLimit(
	app: FastifyInstance,
	{ max, windowSeconds }: { max: number; windowSeconds: number },
) {
	return app.rateLimit({ max, timeWindow: windowSeconds * 1000 });
}
