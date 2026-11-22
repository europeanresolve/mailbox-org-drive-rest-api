import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { type Db, MongoClient } from "mongodb";
import { inject } from "vitest";
import { stringify } from "yaml";
import { start } from "../../src/server.ts";
import { STACK } from "../integration/global-setup.ts";
import { captureLogs, type LogCapture } from "./log-capture.ts";

export type KeySpec = {
	name: string;
	/** The raw key. Only its hash is written to the config file. */
	key: string;
	grants: string[];
};

export type CollectionsAppOptions = {
	/** The `collections:` block as a plain object; it goes through loadConfig as YAML. */
	collections: Record<string, unknown>;
	keys?: KeySpec[];
	/** Extra keys of the `server:` block, for example `trustProxy`. */
	server?: Record<string, unknown>;
};

export type CollectionsApp = {
	/** The running Fastify instance, for `app.inject` with a chosen `remoteAddress`. */
	app: FastifyInstance;
	port: number;
	url: string;
	/** The per-test database the service writes to. */
	db: Db;
	logs: LogCapture;
	fetch(path: string, init?: RequestInit): Promise<Response>;
	close(): Promise<void>;
};

/** A fresh key in the documented format: `mdra_` plus 43 base64url characters. */
export function newKey(): string {
	return `mdra_${randomBytes(32).toString("base64url")}`;
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

let counter = 0;

/**
 * Starts the real composition root (`start()`) from a generated config.yaml,
 * against its own MongoDB database on the Compose stack, and drops that
 * database on close.
 */
export async function collectionsApp(
	options: CollectionsAppOptions,
): Promise<CollectionsApp> {
	const runId = inject("runId");
	const scratch = mkdtempSync(join(tmpdir(), "snook-collections-"));
	const dbName = `it-${runId}-collections-${counter++}`;
	const mongoUri = `${STACK.mongoUri}/${dbName}`;

	const document = {
		mongo: { uri: mongoUri },
		storage: {
			webdav: {
				url: STACK.webdavUrl,
				username: STACK.webdavUser,
				password: STACK.webdavPassword,
			},
		},
		mounts: { live: { path: `/run-${runId}`, mode: "read-write" } },
		...(options.server ? { server: options.server } : {}),
		collections: options.collections,
		apiKeys: (options.keys ?? []).map((k) => ({
			name: k.name,
			hash: sha256Hex(k.key),
			grants: k.grants,
		})),
	};
	const file = join(scratch, "config.yaml");
	writeFileSync(file, stringify(document));

	const logs = captureLogs();
	const service = await start({
		env: { CONFIG_FILE: file, PORT: "0" },
		logStream: logs.stream,
		adapterTimings: { retries: 1, minTimeout: 1, maxTimeout: 5 },
	});
	const address = service.app.server.address();
	if (address === null || typeof address === "string") {
		throw new Error("service is not listening on a TCP port");
	}
	const url = `http://127.0.0.1:${address.port}`;
	const mongo = new MongoClient(mongoUri);
	const db = mongo.db();

	return {
		app: service.app,
		port: address.port,
		url,
		db,
		logs,
		fetch: (path, init) => fetch(`${url}${path}`, init),
		close: async () => {
			await service.close();
			await db.dropDatabase().catch(() => undefined);
			await mongo.close().catch(() => undefined);
			rmSync(scratch, { recursive: true, force: true });
		},
	};
}
