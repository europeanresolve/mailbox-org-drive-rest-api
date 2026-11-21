import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { StorageError } from "../../src/storage/errors.ts";
import { buildMounts, type Mounts } from "../../src/storage/mounts.ts";
import {
	WebDavAdapter,
	type WebDavAdapterOptions,
} from "../../src/storage/webdav-adapter.ts";
import {
	type FakeReply,
	type FakeWebDav,
	type Responder,
	startFakeWebDav,
} from "../helpers/fake-webdav-server.ts";

const CANARY = "CANARY-7f3a Last, First";

function mountsAt(root: string): Mounts {
	const built = buildMounts({ t: { path: root, mode: "read-write" } });
	if (!built.ok) throw new Error("expected buildMounts to succeed");
	return built.mounts;
}

/** Answers request n with replies[n - 1]; the last reply repeats. */
const sequence =
	(...replies: (FakeReply | undefined)[]): Responder =>
	(_req, index) =>
		replies[Math.min(index, replies.length) - 1];

const unavailable: FakeReply = { status: 503 };

let fake: FakeWebDav | undefined;

afterEach(async () => {
	await fake?.close();
	fake = undefined;
});

async function start(
	overrides: Partial<WebDavAdapterOptions> = {},
	root = "/m",
) {
	const server = await startFakeWebDav();
	fake = server;
	const adapter = new WebDavAdapter({
		url: server.url,
		username: "u",
		password: "p",
		retry: { minTimeout: 1, maxTimeout: 5 },
		cooldownMs: 150,
		...overrides,
	});
	const mounts = mountsAt(root);
	return { server, adapter, path: (rel: string) => mounts.resolve("t", rel) };
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		(e: unknown) => e,
	);
}

describe("WebDavAdapter retry", () => {
	it("retries 503, 503 then 207 in exactly 3 requests and succeeds", async () => {
		const { server, adapter, path } = await start();
		server.script(sequence(unavailable, unavailable, undefined));
		const entry = await adapter.stat(path("f.txt"));
		expect(entry.kind).toBe("file");
		expect(server.requests).toHaveLength(3);
	});

	it("retries 429 with Retry-After 0 and succeeds in 2 requests", async () => {
		const { server, adapter, path } = await start();
		server.script(
			sequence({ status: 429, headers: { "Retry-After": "0" } }, undefined),
		);
		await adapter.stat(path("f.txt"));
		expect(server.requests).toHaveLength(2);
	});

	it("waits out a Retry-After within the cap before retrying", async () => {
		const { server, adapter, path } = await start();
		server.script(
			sequence({ status: 429, headers: { "Retry-After": "1" } }, undefined),
		);
		const started = Date.now();
		await adapter.stat(path("f.txt"));
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
		expect(server.requests).toHaveLength(2);
	});

	it("surfaces rate-limited after 1 request when Retry-After exceeds the cap", async () => {
		const { server, adapter, path } = await start();
		server.script(
			sequence({ status: 429, headers: { "Retry-After": "3600" } }, undefined),
		);
		const error = await errorOf(adapter.stat(path("f.txt")));
		expect(error).toBeInstanceOf(StorageError);
		expect(error).toMatchObject({ kind: "rate-limited", status: 429 });
		expect(server.requests).toHaveLength(1);
	});

	it("gives up after 4 retries on unbroken 503s with unavailable", async () => {
		const { server, adapter, path } = await start();
		server.script(sequence(unavailable));
		const error = await errorOf(adapter.stat(path("f.txt")));
		expect(error).toMatchObject({
			kind: "unavailable",
			op: "stat",
			status: 503,
		});
		expect(server.requests).toHaveLength(5);
	});

	it("retries a connection destroyed on the first attempt", async () => {
		const { server, adapter, path } = await start();
		server.script(sequence("destroy", undefined));
		await adapter.stat(path("f.txt"));
		expect(server.requests).toHaveLength(2);
	});

	it("retries a request that exceeds its own timeout", async () => {
		const { server, adapter, path } = await start({
			timeouts: { metaMs: 60 },
		});
		server.script(sequence({ delayMs: 400 }, undefined));
		await adapter.stat(path("f.txt"));
		expect(server.requests).toHaveLength(2);
	});
});

describe("WebDavAdapter never-retry and cooldown", () => {
	it("sends exactly 1 request for a 403 and reports forbidden", async () => {
		const { server, adapter, path } = await start();
		server.script(sequence({ status: 403 }));
		const error = await errorOf(adapter.stat(path("f.txt")));
		expect(error).toMatchObject({ kind: "forbidden", status: 403 });
		expect(server.requests).toHaveLength(1);
	});

	it("sends exactly 1 request for a 401 and reports unauthorized", async () => {
		const { server, adapter, path } = await start();
		server.script(sequence({ status: 401 }));
		const error = await errorOf(adapter.stat(path("f.txt")));
		expect(error).toMatchObject({ kind: "unauthorized", status: 401 });
		expect(server.requests).toHaveLength(1);
	});

	it("fails fast with no request during the 401 cooldown, then resumes", async () => {
		const { server, adapter, path } = await start();
		server.script(sequence({ status: 401 }, undefined));
		await errorOf(adapter.stat(path("f.txt")));
		expect(server.requests).toHaveLength(1);

		const during = await errorOf(adapter.stat(path("f.txt")));
		expect(during).toBeInstanceOf(StorageError);
		expect(during).toMatchObject({ kind: "unauthorized" });
		expect(server.requests).toHaveLength(1);

		await sleep(200);
		const entry = await adapter.stat(path("f.txt"));
		expect(entry.kind).toBe("file");
		expect(server.requests).toHaveLength(2);
	});
});

describe("WebDavAdapter request discipline", () => {
	it("sends every PROPFIND with Depth 0 or 1, an XML content type and the explicit body", async () => {
		const { server, adapter, path } = await start();
		await adapter.stat(path("f.txt"));
		const propfinds = server.requests.filter((r) => r.method === "PROPFIND");
		expect(propfinds.length).toBeGreaterThan(0);
		for (const r of propfinds) {
			expect(["0", "1"]).toContain(r.depth);
			expect(r.headers["content-type"]).toContain("application/xml");
			expect(r.body).toContain("<d:getetag/>");
		}
	});

	it("never has more than 2 requests in flight with 10 calls and concurrency 2", async () => {
		const { server, adapter, path } = await start({ concurrency: 2 });
		server.script(() => ({ delayMs: 50 }));
		await Promise.all(
			Array.from({ length: 10 }, (_, i) => adapter.stat(path(`f${i}`))),
		);
		expect(server.requests).toHaveLength(10);
		expect(server.maxInFlight).toBe(2);
	});

	it("keeps its slot across retries and backoff", async () => {
		const { server, adapter, path } = await start({
			concurrency: 1,
			retry: { minTimeout: 30, maxTimeout: 30 },
		});
		server.script(sequence(unavailable, undefined, undefined));
		await Promise.all([adapter.stat(path("a")), adapter.stat(path("b"))]);
		expect(server.requests.map((r) => r.path)).toEqual([
			"/m/a",
			"/m/a",
			"/m/b",
		]);
	});
});

describe("WebDavAdapter errors carry no path", () => {
	async function failing(
		label: string,
		reply: FakeReply | "refused",
	): Promise<unknown> {
		const { server, adapter, path } = await start({}, `/${CANARY}`);
		if (reply === "refused") {
			await server.close();
		} else {
			server.script(sequence(reply));
		}
		return errorOf(adapter.stat(path(`${label} ${CANARY}.txt`)));
	}

	for (const [label, reply] of [
		["401", { status: 401 }],
		["404", { status: 404 }],
		["exhausted 503", { status: 503 }],
		["ECONNREFUSED", "refused"],
	] as [string, FakeReply | "refused"][]) {
		it(`omits the canary for ${label}`, async () => {
			const err = await failing(label, reply);
			expect(err).toBeInstanceOf(StorageError);
			const text = [
				String(err),
				(err as Error).stack ?? "",
				JSON.stringify(err),
			].join("\n");
			expect(text).not.toMatch(/canary-7f3a/i);
			expect((err as Error).cause).toBeUndefined();
		});
	}
});
