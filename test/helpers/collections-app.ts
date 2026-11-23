import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { type Db, MongoClient } from "mongodb";
import { inject } from "vitest";
import { stringify } from "yaml";
import type { MirrorTimings } from "../../src/mirror/timings.ts";
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
	/** Container role; default `api` so existing tests start no mirror worker. */
	role?: "api" | "worker" | "all";
	/** Test-only timing overrides, passed through to `start()`. */
	mirrorTimings?: Partial<MirrorTimings>;
	/**
	 * When true, adds a dedicated read-write `mirror` mount and points the
	 * mirror block at it. When false/omitted, mirror uses mount `live`.
	 */
	mirror?: boolean;
	/** Override the MongoDB database name (close does not drop it). */
	dbName?: string;
};

export type CollectionsApp = {
	/** The running Fastify instance, for `app.inject` with a chosen `remoteAddress`. */
	app: FastifyInstance;
	port: number;
	url: string;
	/** The per-test database the service writes to. */
	db: Db;
	logs: LogCapture;
	/** WebDAV folder path of the mirror mount (leading slash). */
	mirrorFolder: string;
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

function webdavAuth(): string {
	const raw = `${STACK.webdavUser}:${STACK.webdavPassword}`;
	return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function ensureFolder(path: string): Promise<void> {
	const res = await fetch(new URL(`.${path}/`, STACK.webdavUrl), {
		method: "MKCOL",
		headers: { Authorization: webdavAuth() },
	});
	expectMkcol(res.status);
}

function expectMkcol(status: number): void {
	if (![201, 405].includes(status)) {
		throw new Error(`MKCOL failed with status ${status}`);
	}
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
	const dbName = options.dbName ?? `it-${runId}-collections-${counter++}`;
	const mongoUri = `${STACK.mongoUri}/${dbName}`;
	const role = options.role ?? "api";
	const useMirrorMount = options.mirror === true;
	const mirrorFolder = useMirrorMount
		? `/run-${runId}/m-${dbName}`
		: `/run-${runId}`;

	const livePath = useMirrorMount ? `/run-${runId}/live` : `/run-${runId}`;
	const mounts: Record<string, { path: string; mode: string }> = {
		live: { path: livePath, mode: "read-write" },
	};
	if (useMirrorMount) {
		await ensureFolder(mirrorFolder);
		await ensureFolder(livePath);
		mounts.mirror = { path: mirrorFolder, mode: "read-write" };
	}

	const document = {
		mongo: { uri: mongoUri },
		storage: {
			webdav: {
				url: STACK.webdavUrl,
				username: STACK.webdavUser,
				password: STACK.webdavPassword,
			},
		},
		mounts,
		mirror: { mount: useMirrorMount ? "mirror" : "live" },
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
		env: { CONFIG_FILE: file, PORT: "0", ROLE: role },
		logStream: logs.stream,
		adapterTimings: { retries: 1, minTimeout: 1, maxTimeout: 5 },
		...(options.mirrorTimings === undefined
			? {}
			: { mirrorTimings: options.mirrorTimings }),
	});
	const address = service.app.server.address();
	if (address === null || typeof address === "string") {
		throw new Error("service is not listening on a TCP port");
	}
	const url = `http://127.0.0.1:${address.port}`;
	const mongo = new MongoClient(mongoUri);
	const db = mongo.db();
	const dropOnClose = options.dbName === undefined;

	return {
		app: service.app,
		port: address.port,
		url,
		db,
		logs,
		mirrorFolder,
		fetch: (path, init) => fetch(`${url}${path}`, init),
		close: async () => {
			await service.close();
			if (dropOnClose) {
				await db.dropDatabase().catch(() => undefined);
			}
			await mongo.close().catch(() => undefined);
			rmSync(scratch, { recursive: true, force: true });
		},
	};
}
