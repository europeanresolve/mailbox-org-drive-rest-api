import Fastify, { type FastifyInstance, LogController } from "fastify";
import type { Db } from "mongodb";
import type { DestinationStream } from "pino";
import { registerCollections } from "./collections/routes.ts";
import type { Config } from "./config/schema.ts";
import { type ReadinessChecks, registerHealthRoutes } from "./http/health.ts";
import { loggerOptions, registerLogging } from "./http/logging.ts";

export interface AppOptions {
	logger?: { level?: string; stream?: DestinationStream };
	/** Without checks only /health is registered. */
	checks?: ReadinessChecks;
	/** Without it no collection routes are registered. */
	collections?: { config: Config; db: Db };
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
	if (options.collections) registerCollections(app, options.collections);
	return app;
}
