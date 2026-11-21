import type { FastifyInstance } from "fastify";
import pino, { type DestinationStream } from "pino";
import { buildApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config/load.ts";

export type AdapterTimings = {
	retries?: number;
	minTimeout?: number;
	maxTimeout?: number;
};

export async function start(
	options: {
		env?: NodeJS.ProcessEnv;
		logStream?: DestinationStream;
		/** Test-only: shortens the adapter's retry waits. Not a config key. */
		adapterTimings?: AdapterTimings;
	} = {},
): Promise<{ app: FastifyInstance; close(): Promise<void> }> {
	const config = loadConfig(options.env ?? process.env);
	const app = buildApp({
		logger: {
			level: config.server.logLevel,
			...(options.logStream ? { stream: options.logStream } : {}),
		},
	});

	const shutdown = (): void => {
		app.close().then(
			() => process.exit(0),
			() => process.exit(1),
		);
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);

	await app.listen({ host: "0.0.0.0", port: config.server.port });
	// Names and modes only: real Drive paths never reach a log (D-19).
	app.log.info(
		{
			port: config.server.port,
			logLevel: config.server.logLevel,
			mounts: Object.entries(config.mounts).map(([name, { mode }]) => ({
				name,
				mode,
			})),
		},
		"configuration loaded",
	);
	// RED skeleton: the real wiring (Mongo, Drive probe, close) comes in GREEN.
	return { app, close: () => app.close() };
}

if (import.meta.main) {
	try {
		await start();
	} catch (error) {
		const bootstrap = pino(pino.destination(2));
		if (error instanceof ConfigError) {
			bootstrap.fatal({ issues: error.issues }, "invalid configuration");
		} else {
			bootstrap.fatal(
				{ err: { type: (error as Error).constructor.name } },
				"startup failed",
			);
		}
		process.exitCode = 1;
	}
}
