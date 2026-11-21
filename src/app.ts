import Fastify, { type FastifyInstance, LogController } from "fastify";
import type { DestinationStream } from "pino";
import { loggerOptions, registerLogging } from "./http/logging.ts";

// Later plans extend this with `checks`.
export interface AppOptions {
	logger?: { level?: string; stream?: DestinationStream };
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
	app.get("/health", async () => ({ status: "ok" }));
	return app;
}
