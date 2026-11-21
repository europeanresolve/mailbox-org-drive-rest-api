import Fastify, { type FastifyInstance } from "fastify";

// Later plans extend this with `logger` and `checks`.
// biome-ignore lint/suspicious/noEmptyInterface: intentionally empty, extended by plans 01-04 and 01-09
export interface AppOptions {}

export function buildApp(_options: AppOptions = {}): FastifyInstance {
	// Plain Fastify logger for now; plan 01-04 replaces it with the PII-free harness.
	// /health carries no personal data.
	const app = Fastify({ logger: { level: "info" } });
	app.get("/health", async () => ({ status: "ok" }));
	return app;
}
