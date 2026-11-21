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
	propfindReply,
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
	it("records only PROPFINDs with Depth 0 or 1 across all seven operations", async () => {
		const { server, adapter, path } = await start();
		await adapter.stat(path("f.txt"));
		await adapter.list(path("d"));
		await adapter.read(path("f.txt"));
		await adapter.write(path("f.txt"), Buffer.from("synthetic"));
		await adapter.mkdir(path("e"));
		await adapter.move(path("f.txt"), path("g.txt"), { overwrite: false });
		await adapter.delete(path("g.txt"));
		const propfinds = server.requests.filter((r) => r.method === "PROPFIND");
		expect(propfinds.length).toBeGreaterThanOrEqual(5);
		for (const r of propfinds) {
			expect(["0", "1"]).toContain(r.depth);
			expect(r.headers["content-type"]).toContain("application/xml");
			expect(r.body).toContain("<d:getetag/>");
		}
		expect(
			server.requests.every((r) =>
				["PROPFIND", "GET", "PUT", "MKCOL", "MOVE", "DELETE"].includes(
					r.method,
				),
			),
		).toBe(true);
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

describe("WebDavAdapter semantic rules", () => {
	it("rejects a move onto itself with conflict and sends no request", async () => {
		const { server, adapter, path } = await start();
		const error = await errorOf(
			adapter.move(path("f.txt"), path("f.txt"), { overwrite: true }),
		);
		expect(error).toMatchObject({ kind: "conflict", op: "move" });
		expect(server.requests).toHaveLength(0);
	});

	it("classifies a 403 MOVE with a missing source as not-found using one Depth 0 stat", async () => {
		const { server, adapter, path } = await start();
		server.script((req) => {
			if (req.method === "MOVE") return { status: 403 };
			if (req.method === "PROPFIND") return { status: 404 };
			return undefined;
		});
		const error = await errorOf(
			adapter.move(path("from"), path("to"), { overwrite: false }),
		);
		expect(error).toMatchObject({ kind: "not-found", op: "move" });
		expect(server.requests.map((r) => [r.method, r.depth])).toEqual([
			["MOVE", undefined],
			["PROPFIND", "0"],
		]);
		expect(server.requests[1]?.path).toBe("/m/from");
	});

	it("classifies a 412 MOVE with the source present as conflict", async () => {
		const { server, adapter, path } = await start();
		server.script((req) =>
			req.method === "MOVE" ? { status: 412 } : undefined,
		);
		const error = await errorOf(
			adapter.move(path("from"), path("to"), { overwrite: false }),
		);
		expect(error).toMatchObject({ kind: "conflict", op: "move", status: 412 });
	});

	it("sends Overwrite F for overwrite false and T for overwrite true", async () => {
		const { server, adapter, path } = await start();
		await adapter.move(path("a"), path("b"), { overwrite: false });
		await adapter.move(path("c"), path("d"), { overwrite: true });
		const moves = server.requests.filter((r) => r.method === "MOVE");
		expect(moves.map((r) => r.headers.overwrite)).toEqual(["F", "T"]);
	});

	it("rejects deleting a folder with conflict and never sends DELETE", async () => {
		const { server, adapter, path } = await start();
		server.script((req) =>
			req.method === "PROPFIND" ? propfindReply(req.path, "dir") : undefined,
		);
		const error = await errorOf(adapter.delete(path("d")));
		expect(error).toMatchObject({ kind: "conflict", op: "delete" });
		expect(server.requests.some((r) => r.method === "DELETE")).toBe(false);
	});

	it("rejects reading a folder with conflict and never sends GET", async () => {
		const { server, adapter, path } = await start();
		server.script((req) =>
			req.method === "PROPFIND" ? propfindReply(req.path, "dir") : undefined,
		);
		const error = await errorOf(adapter.read(path("d")));
		expect(error).toMatchObject({ kind: "conflict", op: "read" });
		expect(server.requests.some((r) => r.method === "GET")).toBe(false);
	});

	it("rejects a file above maxBytes with too-large before downloading it", async () => {
		const { server, adapter, path } = await start();
		const error = await errorOf(adapter.read(path("f.txt"), { maxBytes: 4 }));
		expect(error).toMatchObject({ kind: "too-large", op: "read" });
		expect(server.requests.some((r) => r.method === "GET")).toBe(false);
	});

	it("rejects a listing that answers with the requested file itself as conflict", async () => {
		const { server, adapter, path } = await start();
		server.script((req) =>
			req.method === "PROPFIND" ? propfindReply(req.path, "file") : undefined,
		);
		const error = await errorOf(adapter.list(path("f.txt")));
		expect(error).toMatchObject({ kind: "conflict", op: "list" });
	});
});

describe("WebDavAdapter retried MOVE and DELETE", () => {
	it("counts a retried DELETE that gets 404 as success", async () => {
		const { server, adapter, path } = await start();
		let deletes = 0;
		server.script((req) => {
			if (req.method !== "DELETE") return undefined;
			deletes++;
			return deletes === 1 ? "destroy" : { status: 404 };
		});
		await expect(adapter.delete(path("f.txt"))).resolves.toBeUndefined();
		expect(deletes).toBe(2);
	});

	it("does not mask a 404 on a first DELETE attempt", async () => {
		const { server, adapter, path } = await start();
		server.script((req) =>
			req.method === "DELETE" ? { status: 404 } : undefined,
		);
		const error = await errorOf(adapter.delete(path("f.txt")));
		expect(error).toMatchObject({ kind: "not-found", op: "delete" });
	});

	function scriptRetriedMove(server: FakeWebDav): void {
		let moves = 0;
		server.script((req) => {
			if (req.method === "MOVE") {
				moves++;
				return moves === 1 ? "destroy" : { status: 403 };
			}
			if (req.method === "PROPFIND" && req.path === "/m/from") {
				return { status: 404 };
			}
			return undefined;
		});
	}

	it("counts a retried MOVE as success when the source is gone and the destination exists", async () => {
		const { server, adapter, path } = await start();
		scriptRetriedMove(server);
		await expect(
			adapter.move(path("from"), path("to"), { overwrite: false }),
		).resolves.toBeUndefined();
	});

	it("verifies a retried MOVE at concurrency 1 without deadlocking", async () => {
		const { server, adapter, path } = await start({ concurrency: 1 });
		scriptRetriedMove(server);
		const outcome = await Promise.race([
			adapter
				.move(path("from"), path("to"), { overwrite: false })
				.then(() => "done"),
			sleep(2000).then(() => "deadlock"),
		]);
		expect(outcome).toBe("done");
	});

	it("does not treat a retried MOVE as done while the source still exists", async () => {
		const { server, adapter, path } = await start();
		let moves = 0;
		server.script((req) => {
			if (req.method !== "MOVE") return undefined;
			moves++;
			return moves === 1 ? "destroy" : { status: 412 };
		});
		const error = await errorOf(
			adapter.move(path("from"), path("to"), { overwrite: false }),
		);
		expect(error).toMatchObject({ kind: "conflict", op: "move" });
	});
});
