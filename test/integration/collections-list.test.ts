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
