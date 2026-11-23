import { afterAll, describe, expect, inject, it } from "vitest";
import { PROBLEM_JSON } from "../../src/http/logging.ts";
import { collectionsApp, newKey } from "../helpers/collections-app.ts";
import { fetchMirror, readRows, waitUntil } from "../helpers/mirror.ts";

const contactCollection = {
	contact: {
		schema: {
			type: "object",
			additionalProperties: false,
			required: ["email", "name"],
			properties: {
				email: { type: "string", maxLength: 254, format: "email" },
				name: { type: "string", maxLength: 100 },
			},
		},
		operations: { create: "anonymous", get: "apiKey" },
		rateLimit: { max: 10_000, windowSeconds: 60 },
	},
} as const;

const opsKey = newKey();
const readerKey = newKey();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function configLoadedRole(lines: string[]): string | undefined {
	for (const line of lines) {
		try {
			const row = JSON.parse(line) as { msg?: string; role?: string };
			if (row.msg === "configuration loaded") return row.role;
		} catch {
			// not JSON
		}
	}
	return undefined;
}

describe("container roles through start() (03-08)", () => {
	const runId = inject("runId");
	const sharedDb = `it-${runId}-roles-matrix`;

	let apiApp: Awaited<ReturnType<typeof collectionsApp>>;
	let workerApp: Awaited<ReturnType<typeof collectionsApp>>;

	afterAll(async () => {
		await apiApp?.close();
		await workerApp?.close();
	});

	it("ROLE=api serves /v1, marks dirty, never writes the mirror", async () => {
		apiApp = await collectionsApp({
			role: "api",
			mirror: true,
			dbName: sharedDb,
			mirrorTimings: { debounceMs: 100, pollMs: 50 },
			collections: contactCollection,
			keys: [
				{
					name: "ops",
					key: opsKey,
					grants: ["mirror:status"],
				},
				{ name: "reader", key: readerKey, grants: ["contact:get"] },
			],
		});
		expect(configLoadedRole(apiApp.logs.lines())).toBe("api");

		const create = await apiApp.fetch("/v1/contact", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				email: "api@example.invalid",
				name: "Api Only",
			}),
		});
		expect(create.status).toBe(201);

		await sleep(1000);
		expect(await fetchMirror(apiApp.mirrorFolder, "contact.xlsx")).toBeNull();

		const state = await apiApp.db
			.collection<{
				_id: string;
				dirtySeq?: number;
				mirroredSeq?: number;
			}>("mirror_state")
			.findOne({ _id: "contact" });
		expect(state?.dirtySeq).toBe(1);
		expect(state?.mirroredSeq === undefined || state?.mirroredSeq === 0).toBe(
			true,
		);

		expect((await apiApp.fetch("/health")).status).toBe(200);
		expect((await apiApp.fetch("/ready")).status).toBe(200);

		const status = await apiApp.fetch("/mirror/status", {
			headers: { authorization: `Bearer ${opsKey}` },
		});
		expect(status.status).toBe(200);
	});

	it("ROLE=worker serves no /v1 routes and mirrors pending records", async () => {
		workerApp = await collectionsApp({
			role: "worker",
			mirror: true,
			dbName: sharedDb,
			mirrorTimings: { debounceMs: 100, pollMs: 50 },
			collections: contactCollection,
			keys: [
				{
					name: "ops",
					key: opsKey,
					grants: ["mirror:status"],
				},
			],
		});
		expect(configLoadedRole(workerApp.logs.lines())).toBe("worker");

		const blocked = await workerApp.fetch("/v1/contact", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				email: "worker@example.invalid",
				name: "Worker",
			}),
		});
		expect(blocked.status).toBe(404);
		expect(blocked.headers.get("content-type")).toContain(PROBLEM_JSON);

		expect((await workerApp.fetch("/health")).status).toBe(200);
		expect((await workerApp.fetch("/ready")).status).toBe(200);

		await waitUntil(
			async () => {
				const bytes = await fetchMirror(workerApp.mirrorFolder, "contact.xlsx");
				if (bytes === null) return false;
				const { rows } = await readRows(bytes);
				return rows.some((row) => row.includes("api@example.invalid"));
			},
			5000,
			50,
		);
	});

	it("ROLE=all writes through the API and the mirror", async () => {
		const allApp = await collectionsApp({
			role: "all",
			mirror: true,
			mirrorTimings: { debounceMs: 100, pollMs: 50 },
			collections: contactCollection,
		});
		try {
			expect(configLoadedRole(allApp.logs.lines())).toBe("all");

			const create = await allApp.fetch("/v1/contact", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					email: "all@example.invalid",
					name: "All Role",
				}),
			});
			expect(create.status).toBe(201);

			const body = (await create.json()) as { id: string };
			await waitUntil(
				async () => {
					const bytes = await fetchMirror(allApp.mirrorFolder, "contact.xlsx");
					if (bytes === null) return false;
					const { rows } = await readRows(bytes);
					return rows[1]?.[0] === body.id;
				},
				5000,
				50,
			);
		} finally {
			await allApp.close();
		}
	});
});
