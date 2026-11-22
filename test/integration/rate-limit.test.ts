import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type CollectionsApp,
	collectionsApp,
	newKey,
} from "../helpers/collections-app.ts";

const key = newKey();
const CANARY = "CANARY-7f3a@example.invalid";

const schema = {
	type: "object",
	additionalProperties: false,
	required: ["email"],
	properties: { email: { type: "string", maxLength: 254 } },
};
const limit = { max: 3, windowSeconds: 2 };
const collections = {
	contact: {
		schema,
		operations: { create: "anonymous", list: "anonymous", get: "apiKey" },
		rateLimit: limit,
	},
	other: {
		schema,
		operations: { create: "anonymous" },
		rateLimit: limit,
	},
	plain: { schema, operations: { create: "anonymous" } },
};
const keys = [{ name: "reader", key, grants: ["contact:get"] }];

let direct: CollectionsApp;
let behindOne: CollectionsApp;
let behindRange: CollectionsApp;

beforeAll(async () => {
	direct = await collectionsApp({ collections, keys });
	behindOne = await collectionsApp({
		collections,
		keys,
		server: { trustProxy: ["127.0.0.1"] },
	});
	behindRange = await collectionsApp({
		collections,
		keys,
		server: { trustProxy: ["10.0.0.0/8"] },
	});
});

afterAll(async () => {
	await direct?.close();
	await behindOne?.close();
	await behindRange?.close();
});

const BODY = JSON.stringify({ email: "a@example.invalid" });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function post(
	app: CollectionsApp,
	remoteAddress: string,
	headers: Record<string, string> = {},
	path = "/v1/contact",
	payload = BODY,
) {
	return app.app.inject({
		method: "POST",
		url: path,
		remoteAddress,
		headers: { "content-type": "application/json", ...headers },
		payload,
	});
}

function list(app: CollectionsApp, remoteAddress: string) {
	return app.app.inject({ method: "GET", url: "/v1/contact", remoteAddress });
}

/** Status codes of the given responses as one string, "201,201,429": a single-line failure. */
async function statuses(
	...pending: Promise<{ statusCode: number }>[]
): Promise<string> {
	return (await Promise.all(pending)).map((res) => res.statusCode).join(",");
}

async function inOrder(
	...calls: (() => Promise<{ statusCode: number }>)[]
): Promise<string> {
	const codes: number[] = [];
	for (const call of calls) codes.push((await call()).statusCode);
	return codes.join(",");
}

const count = (app: CollectionsApp, name: string) =>
	app.db.collection(`records_${name}`).countDocuments();

describe("anonymous create", () => {
	it("allows max requests, then answers 429 problem+json with Retry-After", async () => {
		const ip = "203.0.113.7";
		const before = await count(direct, "contact");
		expect(
			await inOrder(
				() => post(direct, ip),
				() => post(direct, ip),
				() => post(direct, ip),
			),
		).toBe("201,201,201");
		const res = await post(direct, ip);
		expect(res.statusCode).toBe(429);
		expect(String(res.headers["content-type"])).toContain(
			"application/problem+json",
		);
		expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
		expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(2);
		expect((res.json() as { status: number }).status).toBe(429);
		expect(await count(direct, "contact")).toBe(before + 3);
	});

	it("answers 429 before the body is parsed", async () => {
		const ip = "203.0.113.20";
		await statuses(post(direct, ip), post(direct, ip), post(direct, ip));
		const res = await post(direct, ip, {}, "/v1/contact", "{not json");
		expect(res.statusCode).toBe(429);
	});

	it("is allowed again once the window has passed", async () => {
		const ip = "203.0.113.11";
		await statuses(post(direct, ip), post(direct, ip), post(direct, ip));
		expect((await post(direct, ip)).statusCode).toBe(429);
		await sleep(2100);
		expect((await post(direct, ip)).statusCode).toBe(201);
	});

	it("gives exactly max successes to parallel requests from one IP", async () => {
		const ip = "203.0.113.12";
		const results = await Promise.all(
			Array.from({ length: 8 }, () => post(direct, ip)),
		);
		const ok = results.filter((res) => res.statusCode === 201).length;
		const limited = results.filter((res) => res.statusCode === 429).length;
		expect(`${ok}/${limited}`).toBe("3/5");
	});

	it("limits 10 per 60 seconds when the collection sets nothing", async () => {
		const ip = "203.0.113.13";
		const codes: number[] = [];
		for (let i = 0; i < 11; i++) {
			codes.push((await post(direct, ip, {}, "/v1/plain")).statusCode);
		}
		expect(codes.join(",")).toBe(`${"201,".repeat(10)}429`);
	});
});

describe("buckets", () => {
	it("share one bucket between the anonymous create and list of a collection", async () => {
		const ip = "203.0.113.8";
		expect(
			await inOrder(
				() => post(direct, ip),
				() => post(direct, ip),
				() => list(direct, ip),
			),
		).toBe("201,201,200");
		expect(await inOrder(() => list(direct, ip))).toBe("429");
		expect(await inOrder(() => post(direct, ip))).toBe("429");
	});

	it("are separate per collection", async () => {
		const ip = "203.0.113.14";
		await statuses(post(direct, ip), post(direct, ip), post(direct, ip));
		expect((await post(direct, ip)).statusCode).toBe(429);
		expect((await post(direct, ip, {}, "/v1/other")).statusCode).toBe(201);
	});

	it("do not limit an apiKey operation", async () => {
		const ip = "203.0.113.15";
		const created = await post(direct, "203.0.113.16");
		const { id } = created.json() as { id: string };
		await statuses(post(direct, ip), post(direct, ip), post(direct, ip));
		expect((await post(direct, ip)).statusCode).toBe(429);
		const res = await direct.app.inject({
			method: "GET",
			url: `/v1/contact/${id}`,
			remoteAddress: ip,
			headers: { authorization: `Bearer ${key}` },
		});
		expect(res.statusCode).toBe(200);
	});
});

describe("trustProxy empty", () => {
	it("ignores a forged X-Forwarded-For from any peer", async () => {
		const ip = "203.0.113.9";
		expect(
			await inOrder(
				() => post(direct, ip, { "x-forwarded-for": "198.51.100.1" }),
				() => post(direct, ip, { "x-forwarded-for": "198.51.100.2" }),
				() => post(direct, ip, { "x-forwarded-for": "198.51.100.3" }),
				() => post(direct, ip, { "x-forwarded-for": "198.51.100.4" }),
			),
		).toBe("201,201,201,429");
	});
});

describe("trustProxy with one proxy address", () => {
	it("keys on the forwarded client when the peer is the proxy", async () => {
		const proxy = "127.0.0.1";
		const via = (client: string) => () =>
			post(behindOne, proxy, { "x-forwarded-for": client });
		expect(
			await inOrder(
				via("198.51.100.1"),
				via("198.51.100.1"),
				via("198.51.100.1"),
				via("198.51.100.2"),
			),
		).toBe("201,201,201,201");
		expect(await inOrder(via("198.51.100.1"))).toBe("429");
	});

	it("also trusts the IPv4-mapped form of the proxy address", async () => {
		const via = (client: string) => () =>
			post(behindOne, "::ffff:127.0.0.1", { "x-forwarded-for": client });
		expect(
			await inOrder(
				via("198.51.100.30"),
				via("198.51.100.30"),
				via("198.51.100.30"),
			),
		).toBe("201,201,201");
		expect(await inOrder(via("198.51.100.30"))).toBe("429");
		expect(await inOrder(via("198.51.100.31"))).toBe("201");
	});

	it("ignores X-Forwarded-For from a peer that is not the proxy", async () => {
		const ip = "203.0.113.40";
		expect(
			await inOrder(
				() => post(behindOne, ip, { "x-forwarded-for": "198.51.100.41" }),
				() => post(behindOne, ip, { "x-forwarded-for": "198.51.100.42" }),
				() => post(behindOne, ip, { "x-forwarded-for": "198.51.100.43" }),
				() => post(behindOne, ip, { "x-forwarded-for": "198.51.100.44" }),
			),
		).toBe("201,201,201,429");
	});
});

describe("trustProxy with a CIDR", () => {
	it("uses the nearest address that is not a trusted proxy", async () => {
		const chain = { "x-forwarded-for": "198.51.100.9, 10.0.0.5" };
		expect(
			await inOrder(
				() => post(behindRange, "10.0.0.1", chain),
				() => post(behindRange, "10.0.0.1", chain),
				() => post(behindRange, "10.0.0.1", chain),
			),
		).toBe("201,201,201");
		// The same bucket is reached by that client connecting directly.
		expect(await inOrder(() => post(behindRange, "198.51.100.9"))).toBe("429");
	});

	it("is not moved by a forged entry in front of the real client", async () => {
		const forged = (fake: string) => ({
			"x-forwarded-for": `${fake}, 198.51.100.50, 10.0.0.5`,
		});
		expect(
			await inOrder(
				() => post(behindRange, "10.0.0.1", forged("1.1.1.1")),
				() => post(behindRange, "10.0.0.1", forged("2.2.2.2")),
				() => post(behindRange, "10.0.0.1", forged("3.3.3.3")),
				() => post(behindRange, "10.0.0.1", forged("4.4.4.4")),
			),
		).toBe("201,201,201,429");
	});

	it("falls back to the peer when it is outside the range", async () => {
		const ip = "203.0.113.10";
		expect(
			await inOrder(
				() => post(behindRange, ip, { "x-forwarded-for": "198.51.100.60" }),
				() => post(behindRange, ip, { "x-forwarded-for": "198.51.100.61" }),
				() => post(behindRange, ip, { "x-forwarded-for": "198.51.100.62" }),
			),
		).toBe("201,201,201");
		expect(await inOrder(() => post(behindRange, ip))).toBe("429");
	});
});

describe("what a 429 reveals", () => {
	it("carries no body field or forwarded address in the reply or the logs", async () => {
		const ip = "203.0.113.70";
		const hostile = { "x-forwarded-for": CANARY };
		const body = JSON.stringify({ email: CANARY });
		await statuses(
			post(direct, ip, hostile, "/v1/contact", body),
			post(direct, ip, hostile, "/v1/contact", body),
			post(direct, ip, hostile, "/v1/contact", body),
		);
		const res = await post(direct, ip, hostile, "/v1/contact", body);
		expect(res.statusCode).toBe(429);
		expect(res.body).not.toContain("CANARY");
		expect(JSON.stringify(res.headers)).not.toContain("CANARY");
		const limitedLine = direct.logs
			.lines()
			.filter((line) => line.includes('"status":429'));
		expect(limitedLine.length).toBeGreaterThan(0);
		expect(direct.logs.lines().join("\n")).not.toContain("CANARY");
	});
});
