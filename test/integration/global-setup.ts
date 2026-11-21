import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import type { TestProject } from "vitest/node";

declare module "vitest" {
	export interface ProvidedContext {
		runId: string;
	}
}

export const STACK = Object.freeze({
	mongoUri: "mongodb://127.0.0.1:27017",
	webdavUrl: "http://127.0.0.1:6065/",
	webdavUser: "dev",
	webdavPassword: "dev-password",
});

const POLL_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;

export function assertLoopback(_urls: string[]): void {
	// RED stub: never throws. The guard lands in the GREEN commit.
}

function webdavAuth(): string {
	const raw = `${STACK.webdavUser}:${STACK.webdavPassword}`;
	return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function mongoUp(): Promise<boolean> {
	const client = new MongoClient(STACK.mongoUri, {
		serverSelectionTimeoutMS: 1000,
	});
	try {
		await client.connect();
		const res = await client.db("admin").command({ ping: 1 });
		return res.ok === 1;
	} catch {
		return false;
	} finally {
		await client.close().catch(() => undefined);
	}
}

async function webdavUp(): Promise<boolean> {
	try {
		const res = await fetch(STACK.webdavUrl, {
			method: "PROPFIND",
			headers: { Authorization: webdavAuth(), Depth: "0" },
			signal: AbortSignal.timeout(1000),
		});
		return res.status === 207;
	} catch {
		return false;
	}
}

async function waitForStack(): Promise<void> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	for (;;) {
		const [mongo, webdav] = await Promise.all([mongoUp(), webdavUp()]);
		if (mongo && webdav) return;
		if (Date.now() >= deadline) {
			throw new Error("integration stack did not become ready within 10 s");
		}
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}

export default async function setup(project: TestProject) {
	await waitForStack();

	const runId = randomUUID();
	const folder = new URL(`run-${runId}/`, STACK.webdavUrl);
	const mkcol = await fetch(folder, {
		method: "MKCOL",
		headers: { Authorization: webdavAuth() },
	});
	if (!mkcol.ok) {
		throw new Error(
			`WebDAV MKCOL for the run folder failed with status ${mkcol.status}`,
		);
	}
	project.provide("runId", runId);

	return async () => {
		await fetch(folder, {
			method: "DELETE",
			headers: { Authorization: webdavAuth() },
		});
		const client = new MongoClient(STACK.mongoUri, {
			serverSelectionTimeoutMS: 1000,
		});
		try {
			await client.connect();
			await client.db(`it-${runId}`).dropDatabase();
		} finally {
			await client.close().catch(() => undefined);
		}
	};
}
