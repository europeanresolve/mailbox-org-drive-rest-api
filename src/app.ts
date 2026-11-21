import Fastify, { type FastifyInstance, LogController } from "fastify";
import type { DestinationStream } from "pino";
import { type ReadinessChecks, registerHealthRoutes } from "./http/health.ts";
import { loggerOptions, registerLogging } from "./http/logging.ts";

export interface AppOptions {
	logger?: { level?: string; stream?: DestinationStream };
	/** Without checks only /health is registered. */
	checks?: ReadinessChecks;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
	const app = Fastify({
		logger: loggerOptions(options.logger?.level, options.logger?.stream),
		// Fastify's default request logging carries the raw URL; logging.ts emits one safe line instead.
		logController: new LogController({ disableRequestLogging: true }),
		// Request ids are always generated; a client-sent header must not be trusted or logged.
		requestIdHeader: false,
	});
	registerLogging(app);
	registerHealthRoutes(app, options.checks);
	return app;
}
