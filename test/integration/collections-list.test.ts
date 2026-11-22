import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type CollectionsApp,
	collectionsApp,
	newKey,
} from "../helpers/collections-app.ts";

const key = newKey();

let app: CollectionsApp;

beforeAll(async () => {
	app = await collectionsApp({
		collections: {
			ticket: {
				schema: {
					type: "object",
					additionalProperties: false,
					required: ["status", "address", "priority"],
					properties: {
						status: { type: "string", enum: ["new", "done"], maxLength: 10 },
						nickname: { type: "string", maxLength: 20 },
						address: {
							type: "object",
							additionalProperties: false,
							required: ["country"],
							properties: { country: { type: "string", maxLength: 2 } },
						},
						priority: { type: "integer" },
					},
				},
				operations: { create: "apiKey", get: "apiKey", list: "apiKey" },
				indexes: ["status", "address.country", "priority"],
			},
		},
		keys: [
			{
				name: "backend",
				key,
				grants: ["ticket:create", "ticket:get", "ticket:list"],
			},
		],
	});
});

afterAll(async () => {
	await app?.close();
});

const auth = { authorization: `Bearer ${key}` };

type Ticket = {
	status?: "new" | "done";
	country?: string;
	priority?: number;
};

/** One record, then a pause so createdAt (millisecond resolution) is strictly increasing. */
async function create(ticket: Ticket = {}): Promise<string> {
	const res = await app.fetch("/v1/ticket", {
		method: "POST",
		headers: { ...auth, "content-type": "application/json" },
		body: JSON.stringify({
			status: ticket.status ?? "new",
			address: { country: ticket.country ?? "DE" },
			priority: ticket.priority ?? 1,
		}),
	});
	expect(res.status).toBe(201);
	const { id } = (await res.json()) as { id: string };
	await new Promise((resolve) => setTimeout(resolve, 3));
	return id;
}

type Page = {
	items: { id: string; status: string; priority: number }[];
	nextCursor: string | null;
};

async function list(
	query = "",
): Promise<{ res: Response; page: Page; text: string }> {
	const res = await app.fetch(`/v1/ticket${query === "" ? "" : `?${query}`}`, {
		headers: auth,
	});
	const text = await res.text();
	return {
		res,
		text,
		page: res.status === 200 ? (JSON.parse(text) as Page) : ({} as Page),
	};
}

async function walk(query: string): Promise<string[]> {
	const ids: string[] = [];
	let cursor: string | null = null;
	for (let guard = 0; guard < 20; guard++) {
		const suffix: string = cursor === null ? "" : `&cursor=${cursor}`;
		const { res, page } = await list(`${query}${suffix}`);
		expect(res.status).toBe(200);
		ids.push(...page.items.map((item) => item.id));
		if (page.nextCursor === null) return ids;
		cursor = page.nextCursor;
	}
	return expect.fail("paging did not terminate");
}

async function reset() {
	await app.db.collection("records_ticket").deleteMany({});
}

describe("GET /v1/{name}: paging", () => {
	it("returns an empty list as { items: [], nextCursor: null }", async () => {
		await reset();
		const { res, page } = await list();
		expect(res.status).toBe(200);
		expect(page).toEqual({ items: [], nextCursor: null });
	});

	it("pages through 7 records newest first, each exactly once", async () => {
		await reset();
		const ids: string[] = [];
		for (let i = 0; i < 7; i++) ids.push(await create());

		const first = await list("limit=3");
		expect(first.page.items).toHaveLength(3);
		expect(first.page.nextCursor).not.toBeNull();
		const second = await list(`limit=3&cursor=${first.page.nextCursor}`);
		expect(second.page.items).toHaveLength(3);
		expect(second.page.nextCursor).not.toBeNull();
		const third = await list(`limit=3&cursor=${second.page.nextCursor}`);
		expect(third.page.items).toHaveLength(1);
		expect(third.page.nextCursor).toBeNull();

		const seen = [first, second, third].flatMap((p) =>
			p.page.items.map((item) => item.id),
		);
		expect(seen).toEqual([...ids].reverse());
	});

	it("returns nextCursor null on the last page when the count is a multiple of limit", async () => {
		await reset();
		for (let i = 0; i < 6; i++) await create();
		const first = await list("limit=3");
		const second = await list(`limit=3&cursor=${first.page.nextCursor}`);
		expect(second.page.items).toHaveLength(3);
		expect(second.page.nextCursor).toBeNull();
	});

	it("neither repeats nor skips a record when a newer one arrives between pages", async () => {
		await reset();
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) ids.push(await create());

		const first = await list("limit=3");
		const newer = await create();
		const second = await list(`limit=3&cursor=${first.page.nextCursor}`);

		const seen = [...first.page.items, ...second.page.items].map((i) => i.id);
		expect(seen).toEqual([...ids].reverse());
		expect(seen).not.toContain(newer);
	});

	it("serves the default page size of 50", async () => {
		await reset();
		const docs = Array.from({ length: 51 }, (_, i) => ({
			_id: `id-${String(i).padStart(2, "0")}`,
			_v: 1,
			createdAt: new Date(1_800_000_000_000 + i).toISOString(),
			updatedAt: new Date(1_800_000_000_000 + i).toISOString(),
			data: { status: "new", address: { country: "DE" }, priority: 1 },
		}));
		await app.db.collection("records_ticket").insertMany(docs as never[]);
		const { page } = await list();
		expect(page.items).toHaveLength(50);
		expect(page.nextCursor).not.toBeNull();
	});
});

describe("GET /v1/{name}: equality filters", () => {
	it("filters on an indexed field and on a nested one", async () => {
		await reset();
		await create({ status: "new", country: "DE" });
		await create({ status: "done", country: "FR" });
		await create({ status: "new", country: "FR" });

		const byStatus = await list("status=new");
		expect(byStatus.page.items.map((i) => i.status)).toEqual(["new", "new"]);

		const byCountry = await list("address.country=DE");
		expect(byCountry.page.items).toHaveLength(1);
	});
});

describe("indexes", () => {
	it("creates one compound index per indexed field plus createdAt and updatedAt", async () => {
		const wanted = [
			{ "data.status": 1, _id: 1 },
			{ "data.address.country": 1, _id: 1 },
			{ "data.priority": 1, _id: 1 },
			{ createdAt: 1, _id: 1 },
			{ updatedAt: 1, _id: 1 },
		];
		const records = app.db.collection("records_ticket");
		let keys: unknown[] = [];
		// Index creation runs in the background after listen.
		for (let i = 0; i < 50; i++) {
			keys = (await records.listIndexes().toArray()).map((index) => index.key);
			if (
				wanted.every((w) =>
					keys.some((k) => JSON.stringify(k) === JSON.stringify(w)),
				)
			)
				break;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		for (const w of wanted) {
			expect(keys.map((k) => JSON.stringify(k))).toContain(JSON.stringify(w));
		}
	});
});

describe("GET /v1/{name}: rejected queries", () => {
	it("answers 400 problem+json for a filter on a field that is not indexed, echoing nothing", async () => {
		await reset();
		const { res, text } = await list("nickname=CANARY-7f3a");
		expect(res.status).toBe(400);
		expect(res.headers.get("content-type")).toContain(
			"application/problem+json",
		);
		expect(text).not.toMatch(/nickname|canary-7f3a/i);
		for (const line of app.logs.lines()) {
			expect(line).not.toMatch(/nickname|canary-7f3a/i);
		}
	});
});

describe("GET /v1/{name}: range filters and sort", () => {
	it("returns exactly the records inside a half-open range", async () => {
		await reset();
		for (const priority of [1, 2, 3, 4, 5]) await create({ priority });
		const { page } = await list("priority.gte=2&priority.lt=4&sort=priority");
		expect(page.items.map((item) => item.priority).join()).toBe("2,3");
	});

	it("filters on createdAt with a date", async () => {
		await reset();
		await create();
		const none = await list("createdAt.lt=2020-01-01");
		expect(none.page.items).toHaveLength(0);
		const all = await list("createdAt.gte=2020-01-01");
		expect(all.page.items).toHaveLength(1);
	});

	it("walks every record once in (priority, _id) order, ties included, and back in reverse", async () => {
		await reset();
		const made: { id: string; priority: number }[] = [];
		for (const priority of [3, 1, 2, 2, 3, 1, 2]) {
			made.push({ id: await create({ priority }), priority });
		}
		const ascending = [...made]
			.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : 1))
			.map((m) => m.id);

		expect((await walk("sort=priority&limit=2")).join()).toBe(ascending.join());
		expect((await walk("sort=-priority&limit=2")).join()).toBe(
			[...ascending].reverse().join(),
		);
	});

	it("keeps the filter while paging a sorted list", async () => {
		await reset();
		for (const status of [
			"new",
			"done",
			"new",
			"new",
			"done",
			"new",
		] as const) {
			await create({ status });
		}
		const ids = await walk("status=new&sort=status&limit=3");
		expect(ids).toHaveLength(4);
	});
});

describe("GET /v1/{name}: hostile queries", () => {
	const CANARY = "CANARY-7f3a@example.invalid";

	it("answers 400 for each bad parameter and never echoes it in the body or a log line", async () => {
		await reset();
		await create();
		const asCursor = Buffer.from(
			JSON.stringify({ s: CANARY, v: CANARY, id: CANARY }),
		).toString("base64url");
		const queries = [
			`priority=${encodeURIComponent(CANARY)}`,
			`${encodeURIComponent(CANARY)}=1`,
			`status.${encodeURIComponent(CANARY)}=1`,
			`cursor=${encodeURIComponent(CANARY)}`,
			`cursor=${asCursor}`,
			`sort=${encodeURIComponent(CANARY)}`,
			`limit=${encodeURIComponent(CANARY)}`,
			`status=${encodeURIComponent(CANARY)}&status=${encodeURIComponent(CANARY)}`,
			`status[$ne]=${encodeURIComponent(CANARY)}`,
		];
		for (const query of queries) {
			const { res, text } = await list(query);
			expect(res.status).toBe(400);
			expect(res.headers.get("content-type")).toContain(
				"application/problem+json",
			);
			expect(text).not.toMatch(/canary-7f3a|example\.invalid/i);
		}
		for (const line of app.logs.lines()) {
			expect(line).not.toMatch(/canary-7f3a|example\.invalid/i);
		}
		const routes = app.logs
			.lines()
			.map(
				(line) =>
					JSON.parse(line) as { msg?: string; req?: { route?: string } },
			)
			.filter(
				(entry) =>
					entry.msg === "request" && entry.req?.route?.startsWith("/v1/ticket"),
			)
			.map((entry) => entry.req?.route);
		expect(routes.length).toBeGreaterThan(0);
		for (const route of routes) expect(route).toBe("/v1/ticket");
	});

	it("answers 400 for a tampered cursor that carries an operator object", async () => {
		await reset();
		for (let i = 0; i < 3; i++) await create();
		const first = await list("limit=1");
		const tampered = Buffer.from(
			JSON.stringify({ s: "-createdAt", v: { $gt: "" }, id: "x" }),
		).toString("base64url");
		expect(first.page.nextCursor).not.toBeNull();
		const res = await list(`limit=1&cursor=${tampered}`);
		expect(res.res.status).toBe(400);
	});

	it("accepts limit 1 and 200 and rejects 0 and 201", async () => {
		expect((await list("limit=1")).res.status).toBe(200);
		expect((await list("limit=200")).res.status).toBe(200);
		expect((await list("limit=0")).res.status).toBe(400);
		expect((await list("limit=201")).res.status).toBe(400);
	});
});
