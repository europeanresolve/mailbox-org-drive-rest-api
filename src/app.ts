import Fastify, { type FastifyInstance } from "fastify";

// Later plans extend this with `logger` and `checks`.
// biome-ignore lint/suspicious/noEmptyInterface: intentionally empty, extended by plans 01-04 and 01-09
export interface AppOptions {}

export function buildApp(_options: AppOptions = {}): FastifyInstance {
	return Fastify();
}
