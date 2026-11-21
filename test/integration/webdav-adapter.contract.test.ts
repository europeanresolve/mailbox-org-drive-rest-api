import { describe, expect, inject, it } from "vitest";
import { StorageError } from "../../src/storage/errors.ts";
import { buildMounts, type Mounts } from "../../src/storage/mounts.ts";
import { WebDavAdapter } from "../../src/storage/webdav-adapter.ts";
import { STACK } from "./global-setup.ts";

const runId = inject("runId");

function authHeader(): string {
	const raw = `${STACK.webdavUser}:${STACK.webdavPassword}`;
	return `Basic ${Buffer.from(raw).toString("base64")}`;
}

function mountsAt(root: string): Mounts {
	const built = buildMounts({ t: { path: root, mode: "read-write" } });
	if (!built.ok) throw new Error("expected buildMounts to succeed");
	return built.mounts;
}

function newAdapter(): WebDavAdapter {
	return new WebDavAdapter({
		url: STACK.webdavUrl,
		username: STACK.webdavUser,
		password: STACK.webdavPassword,
	});
}

describe("WebDavAdapter against the Compose server (tracer)", () => {
	it("stats one file through limit, retry, client and mapping", async () => {
		const root = `/run-${runId}/t1`;
		const mkcol = await fetch(new URL(`.${root}/`, STACK.webdavUrl), {
			method: "MKCOL",
			headers: { Authorization: authHeader() },
		});
		expect(mkcol.ok).toBe(true);
		const put = await fetch(new URL(`.${root}/f.txt`, STACK.webdavUrl), {
			method: "PUT",
			headers: { Authorization: authHeader() },
			body: "synthetic",
		});
		expect(put.ok).toBe(true);

		const mounts = mountsAt(root);
		const adapter = newAdapter();

		const entry = await adapter.stat(mounts.resolve("t", "f.txt"));
		expect(entry.kind).toBe("file");
		expect(entry.size).toBe(9);
		expect(typeof entry.etag).toBe("string");

		const error = await adapter.stat(mounts.resolve("t", "missing.txt")).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(StorageError);
		expect(error).toMatchObject({
			kind: "not-found",
			op: "stat",
			status: 404,
		});
	});
});
