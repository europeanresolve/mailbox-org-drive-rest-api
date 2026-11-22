import type { FastifyInstance } from "fastify";
import pino, { type DestinationStream } from "pino";
import { buildApp } from "./app.ts";
import { ensureIndexes, scheduleIndexSetup } from "./collections/indexes.ts";
import { ConfigError, loadConfig } from "./config/load.ts";
import { createMongo } from "./db/mongo.ts";
import { createDriveHealth } from "./storage/drive-health.ts";
import { buildMounts } from "./storage/mounts.ts";
import { WebDavAdapter } from "./storage/webdav-adapter.ts";

const INDEX_RETRY_MS = 30_000;

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
	const mongo = createMongo(config.mongo.uri);
	try {
		const adapter = new WebDavAdapter({
			...config.storage.webdav,
			...(options.adapterTimings ? { retry: options.adapterTimings } : {}),
		});
		const built = buildMounts(config.mounts);
		// loadConfig has already rejected any mount issue, so this is unreachable.
		if (!built.ok) throw new ConfigError(built.issues);
		const { mounts } = built;
		const firstMount = mounts.names()[0];
		// Config requires at least one mount, so this is unreachable too.
		if (firstMount === undefined) throw new ConfigError([]);

		const db = mongo.client.db();
		// The closure lets the app be built before driveHealth exists.
		let driveHealth: ReturnType<typeof createDriveHealth> | undefined;
		const app = buildApp({
			logger: {
				level: config.server.logLevel,
				...(options.logStream ? { stream: options.logStream } : {}),
			},
			checks: {
				mongoPing: mongo.ping,
				driveState: () => driveHealth?.state() ?? "unknown",
			},
			collections: { config, db },
			trustProxy: config.server.trustProxy,
			docs: config.server.docs,
		});
		driveHealth = createDriveHealth({
			probe: () => adapter.stat(mounts.get(firstMount).root),
			log: app.log,
		});

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
				// Names only: schemas and keys never reach a log.
				collections: Object.keys(config.collections),
			},
			"configuration loaded",
		);
		// Not awaited: /health and /ready never depend on it, and an outage at boot only delays it.
		const indexSetup = scheduleIndexSetup({
			ensure: () => ensureIndexes(db, config),
			log: { warn: (fields, message) => app.log.warn(fields, message) },
			retryMs: INDEX_RETRY_MS,
		});
		return {
			app,
			close: async () => {
				indexSetup.stop();
				await app.close();
				await mongo.close();
			},
		};
	} catch (error) {
		await mongo.close().catch(() => undefined);
		throw error;
	}
}

if (import.meta.main) {
	try {
		const { close } = await start();
		const shutdown = (): void => {
			close().then(
				() => process.exit(0),
				() => process.exit(1),
			);
		};
		process.once("SIGTERM", shutdown);
		process.once("SIGINT", shutdown);
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
