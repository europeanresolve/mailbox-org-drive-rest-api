import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import type { DriveState } from "../../src/http/health.ts";

describe("GET /health", () => {
	it("returns 200 with JSON body {status: ok} and needs no backing services", async () => {
		const app = buildApp();
		try {
			const res = await app.inject({ method: "GET", url: "/health" });
			expect(res.statusCode).toBe(200);
			expect(res.headers["content-type"]).toMatch(/^application\/json/);
			expect(res.body).toBe('{"status":"ok"}');
		} finally {
			await app.close();
		}
	});
});

describe("readiness with fake checks", () => {
	function appWith(mongoUp: boolean, drive: DriveState) {
		return buildApp({
			logger: { level: "silent" },
			checks: {
				mongoPing: async () => {
					if (!mongoUp) throw new Error("synthetic mongo failure");
				},
				driveState: () => drive,
			},
		});
	}

	it("has no /ready route when no checks are given", async () => {
		const app = buildApp({ logger: { level: "silent" } });
		try {
			const res = await app.inject({ method: "GET", url: "/ready" });
			expect(res.statusCode).toBe(404);
		} finally {
			await app.close();
		}
	});

	it("is ready with 200 when mongo is up and the drive state is up", async () => {
		const app = appWith(true, "up");
		try {
			const res = await app.inject({ method: "GET", url: "/ready" });
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual({
				status: "ready",
				mongo: "up",
				drive: "up",
			});
		} finally {
			await app.close();
		}
	});

	it("stays 200 and only reports the outage when mongo is up and the drive is down", async () => {
		const app = appWith(true, "unavailable");
		try {
			const res = await app.inject({ method: "GET", url: "/ready" });
			expect(res.statusCode).toBe(200);
			expect(res.json()).toEqual({
				status: "ready",
				mongo: "up",
				drive: "unavailable",
			});
		} finally {
			await app.close();
		}
	});

	it("answers 503 when mongo is down, whatever the drive state", async () => {
		const app = appWith(false, "unavailable");
		try {
			const res = await app.inject({ method: "GET", url: "/ready" });
			expect(res.statusCode).toBe(503);
			expect(res.json()).toEqual({
				status: "not-ready",
				mongo: "down",
				drive: "unavailable",
			});
		} finally {
			await app.close();
		}
	});

	it("keeps /health at 200 even when both checks fail", async () => {
		const app = appWith(false, "unavailable");
		try {
			const res = await app.inject({ method: "GET", url: "/health" });
			expect(res.statusCode).toBe(200);
			expect(res.body).toBe('{"status":"ok"}');
		} finally {
			await app.close();
		}
	});
});
