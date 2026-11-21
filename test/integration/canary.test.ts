import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { afterAll, afterEach, describe, expect, inject, it, vi } from "vitest";
import { start } from "../../src/server.ts";
import { captureLogs } from "../helpers/log-capture.ts";
import { STACK } from "./global-setup.ts";

const runId = inject("runId");
const CANARY = "CANARY-7f3a";
const SCRATCH = mkdtempSync(join(tmpdir(), "snook-canary-"));
const POLL_INTERVAL_MS = 100;
const POLL_BUDGET_MS = 5000;

afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

function authHeader(): string {
	const raw = `${STACK.webdavUser}:${STACK.webdavPassword}`;
	return `Basic ${Buffer.from(raw).toString("base64")}`;
}

// The mount folder is created by the test; the service only ever stats it.
async function makeLiveFolder(): Promise<string> {
	const path = `/run-${runId}/live`;
	const res = await fetch(new URL(`.${path}/`, STACK.webdavUrl), {
		method: "MKCOL",
		headers: { Authorization: authHeader() },
	});
	// 405 means an earlier test in this run already made it.
	expect([201, 405]).toContain(res.status);
	return path;
}

type Overrides = {
	mongoUri?: string;
	webdavUrl?: string;
	webdavPassword?: string;
	mountPath: string;
};

let counter = 0;

async function startService(overrides: Overrides) {
	const file = join(SCRATCH, `c${counter++}.yaml`);
	writeFileSync(
		file,
		[
			"storage:",
			"  webdav:",
			`    url: \${WEBDAV_URL}`,
			`    username: \${WEBDAV_USERNAME}`,
			`    password: \${WEBDAV_APP_PASSWORD}`,
			"mongo:",
			`  uri: \${MONGO_URI}`,
			"mounts:",
			"  live:",
			`    path: "${overrides.mountPath}"`,
			"    mode: read-write",
			"",
		].join("\n"),
	);
	const logs = captureLogs();
	const service = await start({
		env: {
			CONFIG_FILE: file,
			WEBDAV_URL: overrides.webdavUrl ?? STACK.webdavUrl,
			WEBDAV_USERNAME: STACK.webdavUser,
			WEBDAV_APP_PASSWORD: overrides.webdavPassword ?? STACK.webdavPassword,
			MONGO_URI: overrides.mongoUri ?? STACK.mongoUri,
			PORT: "0",
		},
		logStream: logs.stream,
		adapterTimings: { retries: 1, minTimeout: 1, maxTimeout: 5 },
	});
	const address = service.app.server.address();
	if (address === null || typeof address === "string") {
		throw new Error("service is not listening on a TCP port");
	}
	return { ...service, logs, port: address.port };
}

type Ready = { status: number; body: Record<string, unknown> };

async function getReady(port: number): Promise<Ready> {
	const res = await fetch(
		`http://127.0.0.1:${port}/ready?q=${CANARY}@example.invalid`,
	);
	return {
		status: res.status,
		body: (await res.json()) as Record<string, unknown>,
	};
}

/** Polls /ready until the Drive state leaves "unknown" (the probe runs in the background). */
async function readyOnceDriveKnown(port: number): Promise<Ready> {
	const deadline = Date.now() + POLL_BUDGET_MS;
	let last = await getReady(port);
	while (last.body.drive === "unknown" && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		last = await getReady(port);
	}
	return last;
}

function expectNoCanary(lines: string[]): void {
	expect(lines.length).toBeGreaterThan(0);
	for (const line of lines) {
		expect(line).not.toMatch(/canary-7f3a/i);
	}
}

describe("start() against the Compose stack", () => {
	it("starts from config, reports ready with the Drive up, and closes cleanly", async () => {
		const close = vi.spyOn(MongoClient.prototype, "close");
		const mountPath = await makeLiveFolder();
		const service = await startService({ mountPath });
		try {
			const ready = await readyOnceDriveKnown(service.port);
			expect(ready.status).toBe(200);
			expect(ready.body).toEqual({
				status: "ready",
				mongo: "up",
				drive: "up",
			});
			expectNoCanary(service.logs.lines());
		} finally {
			await service.close();
		}
		expect(service.app.server.listening).toBe(false);
		expect(close).toHaveBeenCalledTimes(1);
	});

	describe("failure paths never put the canary into a log line", () => {
		it("(a) a MongoDB URI with the canary as password gives 503", async () => {
			const mountPath = await makeLiveFolder();
			const service = await startService({
				mountPath,
				mongoUri: `mongodb://u:${CANARY}@127.0.0.1:1/x`,
			});
			try {
				const ready = await readyOnceDriveKnown(service.port);
				expect(ready.status).toBe(503);
				expect(ready.body.status).toBe("not-ready");
				expect(ready.body.mongo).toBe("down");
				expectNoCanary(service.logs.lines());
			} finally {
				await service.close();
			}
		});

		it("(b) a WebDAV password that is the canary (401) gives drive unavailable", async () => {
			const mountPath = await makeLiveFolder();
			const service = await startService({
				mountPath,
				webdavPassword: CANARY,
			});
			try {
				const ready = await readyOnceDriveKnown(service.port);
				expect(ready.status).toBe(200);
				expect(ready.body.drive).toBe("unavailable");
				expectNoCanary(service.logs.lines());
			} finally {
				await service.close();
			}
		});

		it("(c) a mount path with the canary that does not exist (404) gives drive unavailable", async () => {
			const service = await startService({
				mountPath: `/run-${runId}/${CANARY} Last, First`,
			});
			try {
				const ready = await readyOnceDriveKnown(service.port);
				expect(ready.status).toBe(200);
				expect(ready.body.drive).toBe("unavailable");
				expectNoCanary(service.logs.lines());
			} finally {
				await service.close();
			}
		});

		it("(d) a refused WebDAV connection gives drive unavailable", async () => {
			const mountPath = await makeLiveFolder();
			const service = await startService({
				mountPath,
				webdavUrl: "http://127.0.0.1:1/",
			});
			try {
				const ready = await readyOnceDriveKnown(service.port);
				expect(ready.status).toBe(200);
				expect(ready.body.drive).toBe("unavailable");
				expectNoCanary(service.logs.lines());
			} finally {
				await service.close();
			}
		});
	});
});
