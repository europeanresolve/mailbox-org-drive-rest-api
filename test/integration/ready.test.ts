import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { STACK } from "./global-setup.ts";

const clients: { close(): Promise<void> }[] = [];

afterAll(async () => {
	await Promise.all(clients.map((client) => client.close()));
});

// RED stand-in for createMongo (src/db/mongo.ts does not exist yet).
function mongoAt(uri: string) {
	const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1500 });
	const mongo = {
		ping: async () => {
			await client.db("admin").command({ ping: 1 });
		},
		close: () => client.close(),
	};
	clients.push(mongo);
	return mongo;
}

describe("GET /ready against the Compose MongoDB (tracer)", () => {
	it("answers 200 ready when a real MongoDB ping succeeds", async () => {
		const mongo = mongoAt(STACK.mongoUri);
		const app = buildApp({
			checks: { mongoPing: mongo.ping, driveState: () => "unknown" },
		});
		try {
			const ready = await app.inject({ method: "GET", url: "/ready" });
			expect(ready.statusCode).toBe(200);
			expect(ready.json()).toEqual({
				status: "ready",
				mongo: "up",
				drive: "unknown",
			});
			const health = await app.inject({ method: "GET", url: "/health" });
			expect(health.statusCode).toBe(200);
		} finally {
			await app.close();
		}
	});

	it("answers 503 not-ready within 3 s when MongoDB is unreachable, and /health stays 200", async () => {
		const mongo = mongoAt("mongodb://127.0.0.1:1");
		const app = buildApp({
			checks: { mongoPing: mongo.ping, driveState: () => "unknown" },
		});
		try {
			const started = Date.now();
			const ready = await app.inject({ method: "GET", url: "/ready" });
			const elapsed = Date.now() - started;
			expect(ready.statusCode).toBe(503);
			expect(ready.json()).toEqual({
				status: "not-ready",
				mongo: "down",
				drive: "unknown",
			});
			expect(elapsed).toBeLessThan(3000);
			const health = await app.inject({ method: "GET", url: "/health" });
			expect(health.statusCode).toBe(200);
		} finally {
			await app.close();
		}
	});
});
