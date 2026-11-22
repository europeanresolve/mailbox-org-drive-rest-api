import Fastify, { type FastifyInstance, LogController } from "fastify";
import type { Db } from "mongodb";
import type { DestinationStream } from "pino";
import { registerCollections } from "./collections/routes.ts";
import type { Config } from "./config/schema.ts";
import { registerDocs } from "./http/docs.ts";
import { type ReadinessChecks, registerHealthRoutes } from "./http/health.ts";
import { loggerOptions, registerLogging } from "./http/logging.ts";

export interface AppOptions {
	logger?: { level?: string; stream?: DestinationStream };
	/** Without checks only /health is registered. */
	checks?: ReadinessChecks;
	/** Without it no collection routes are registered. */
	collections?: { config: Config; db: Db };
	/**
	 * Proxy IPs or CIDRs whose X-Forwarded-For is believed. Empty or absent means the
	 * header is never read and the socket address is the client (D-10).
	 */
	trustProxy?: readonly string[];
	/** Serve the OpenAPI document and UI at /docs; needs `collections` for the config. */
	docs?: boolean;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
	const app = Fastify({
		logger: loggerOptions(options.logger?.level, options.logger?.stream),
		// Fastify's default request logging carries the raw URL; logging.ts emits one safe line instead.
		logController: new LogController({ disableRequestLogging: true }),
		// Request ids are always generated; a client-sent header must not be trusted or logged.
		requestIdHeader: false,
		// Never `true`: that would believe a client-supplied X-Forwarded-For.
		trustProxy:
			options.trustProxy && options.trustProxy.length > 0
				? [...options.trustProxy]
				: false,
	});
	registerLogging(app);
	if (options.docs && options.collections) {
		registerDocs(app, options.collections.config, {
			ready: options.checks !== undefined,
		});
	}
	registerHealthRoutes(app, options.checks);
	if (options.collections) registerCollections(app, options.collections);
	return app;
}
