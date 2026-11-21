import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";

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
