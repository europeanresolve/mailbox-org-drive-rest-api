import type { FastifyInstance } from "fastify";

export type DriveState = "unknown" | "up" | "degraded" | "unavailable";

export interface ReadinessChecks {
	mongoPing(): Promise<void>;
	/** Synchronous and never blocking: /ready must not wait on the Drive. */
	driveState(): DriveState;
}

/**
 * /health is liveness and depends on nothing. /ready (registered only when
 * checks are given) fails on MongoDB down and merely reports the Drive state.
 * The body holds enumerated states only: no host, error text or path (T-01-28).
 */
export function registerHealthRoutes(
	app: FastifyInstance,
	checks?: ReadinessChecks,
): void {
	app.get("/health", async () => ({ status: "ok" }));
	if (checks === undefined) return;

	app.get("/ready", async (request, reply) => {
		try {
			await checks.mongoPing();
		} catch (err) {
			request.log.warn({ err }, "mongo ping failed");
			return reply.status(503).send({
				status: "not-ready",
				mongo: "down",
				drive: checks.driveState(),
			});
		}
		return { status: "ready", mongo: "up", drive: checks.driveState() };
	});
}
