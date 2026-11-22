import { describe, expect, it } from "vitest";
import {
	encodeCursor,
	ListQueryError,
	type ParsedList,
	parseListQuery,
} from "../../src/collections/list-query.ts";

const COLLECTION = {
	schema: {
		type: "object",
		additionalProperties: false,
		required: ["status", "address", "priority", "score", "flag", "nickname"],
		properties: {
			status: { type: "string", maxLength: 10 },
			nickname: { type: "string", maxLength: 10 },
			priority: { type: "integer" },
			score: { type: "number" },
			flag: { type: "boolean" },
			address: {
				type: "object",
				additionalProperties: false,
				required: ["country"],
				properties: { country: { type: "string", maxLength: 2 } },
			},
		},
	},
	// nickname is deliberately not indexed
	indexes: ["status", "address.country", "priority", "score", "flag"],
} as const;

/** A querystring as Fastify hands it over: a repeated key becomes an array. */
function qs(text: string): Record<string, string | string[]> {
	const out: Record<string, string | string[]> = {};
	for (const [key, value] of new URLSearchParams(text)) {
		const seen = out[key];
		if (seen === undefined) out[key] = value;
		else out[key] = [...(Array.isArray(seen) ? seen : [seen]), value];
	}
	return out;
}

function parse(query: unknown): ParsedList {
	return parseListQuery(query, COLLECTION);
}

function parseText(text: string): ParsedList {
	return parse(qs(text));
}

function reject(query: unknown): void {
	expect(() => parse(query)).toThrow(ListQueryError);
}

/** Filters as one line, so a mismatch prints on one line. */
function filters(text: string): string {
	return parseText(text)
		.filters.map((f) => `${f.field} ${f.op} ${JSON.stringify(f.value)}`)
		.join("; ");
}

describe("range filters", () => {
	it("gives one typed condition per bound", () => {
		expect(filters("priority.gte=2&priority.lt=5")).toBe(
			"data.priority gte 2; data.priority lt 5",
		);
	});

	it("treats the plain form and .eq alike and keeps both when both are given", () => {
		expect(filters("status=x&status.eq=y")).toBe(
			'data.status eq "x"; data.status eq "y"',
		);
	});

	it("filters on a nested path", () => {
		expect(filters("address.country.gt=DE")).toBe(
			'data.address.country gt "DE"',
		);
	});
});

describe("createdAt and updatedAt", () => {
	it("accepts a full date and a date-time, normalised to the stored form", () => {
		expect(filters("createdAt.gte=2026-01-01")).toBe(
			'createdAt gte "2026-01-01T00:00:00.000Z"',
		);
		expect(filters("updatedAt.lt=2026-01-01T12:00:00Z")).toBe(
			'updatedAt lt "2026-01-01T12:00:00.000Z"',
		);
		expect(filters("createdAt.lt=2026-01-01T12:00:00%2B01:00")).toBe(
			'createdAt lt "2026-01-01T11:00:00.000Z"',
		);
	});

	it("rejects anything that is not a real date or date-time", () => {
		for (const bad of [
			"yesterday",
			"2026-02-30",
			"2026-13-01",
			"2026-01-01T24:00:00Z",
			"2026-01-01T12:00:00",
			"20260101",
			"",
		]) {
			reject({ "createdAt.gte": bad });
		}
	});
});

describe("typed values", () => {
	it("accepts safe integers and rejects every other spelling", () => {
		expect(filters("priority=-3")).toBe("data.priority eq -3");
		expect(filters("priority=9007199254740991")).toBe(
			"data.priority eq 9007199254740991",
		);
		for (const bad of [
			"1.0",
			"1e3",
			"01",
			"9007199254740992",
			"",
			"+1",
			" 1",
		]) {
			reject({ priority: bad });
		}
	});

	it("accepts finite decimals for a number field", () => {
		expect(filters("score=-0.5")).toBe("data.score eq -0.5");
		expect(filters("score=2")).toBe("data.score eq 2");
		expect(filters("score=1e-3")).toBe("data.score eq 0.001");
		for (const bad of ["NaN", "Infinity", "0x10", "1e999", "", ".5"]) {
			reject({ score: bad });
		}
	});

	it("accepts true and false with eq only", () => {
		expect(filters("flag=true")).toBe("data.flag eq true");
		expect(filters("flag.eq=false")).toBe("data.flag eq false");
		reject({ flag: "yes" });
		reject({ flag: "TRUE" });
		reject({ "flag.gt": "true" });
	});

	it("passes a string field through as is", () => {
		expect(filters("status.gte=a%20b")).toBe('data.status gte "a b"');
	});
});

describe("rejected parameters", () => {
	it("rejects an unknown operator, a field that is not indexed and an unknown parameter", () => {
		reject({ "status.like": "x" });
		reject({ nickname: "x" });
		reject({ "nickname.eq": "x" });
		reject({ foo: "1" });
		reject({ "": "1" });
		reject({ "status.": "1" });
		reject({ constructor: "1" });
		reject(JSON.parse('{"__proto__":"1"}'));
	});

	it("rejects a repeated parameter and an object value", () => {
		reject(qs("status=a&status=b"));
		reject({ status: { $ne: "x" } });
		reject({ "status[$ne]": "x" });
		reject({ limit: ["1", "2"] });
		reject({ sort: ["a", "b"] });
	});
});

describe("sort", () => {
	it("defaults to newest first", () => {
		const sort = parseText("").sort;
		expect(`${sort.field} ${sort.dir}`).toBe("createdAt -1");
	});

	it("sorts ascending and descending on indexed fields and timestamps", () => {
		const ascending = parseText("sort=priority").sort;
		expect(`${ascending.field} ${ascending.dir}`).toBe("data.priority 1");
		const descending = parseText("sort=-address.country").sort;
		expect(`${descending.field} ${descending.dir}`).toBe(
			"data.address.country -1",
		);
		expect(parseText("sort=updatedAt").sort.field).toBe("updatedAt");
		expect(parseText("sort=-updatedAt").sort.dir).toBe(-1);
	});

	it("rejects a field that is not indexed, an empty value and a bare minus", () => {
		for (const bad of ["nickname", "", "-", "--priority", "priority.gte"]) {
			reject({ sort: bad });
		}
	});
});

describe("limit", () => {
	it("defaults to 50 and accepts 1 and 200", () => {
		expect(parseText("").limit).toBe(50);
		expect(parseText("limit=1").limit).toBe(1);
		expect(parseText("limit=200").limit).toBe(200);
	});

	it("rejects 0, 201, a fraction and text", () => {
		for (const bad of ["0", "201", "1.5", "abc", "", "-1", "01", "1e2"]) {
			reject({ limit: bad });
		}
	});
});

describe("cursor", () => {
	const at = "2026-01-01T00:00:00.000Z";
	const raw = (value: unknown) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");

	it("round-trips through encodeCursor", () => {
		const cursor = encodeCursor({ s: "-createdAt", v: at, id: "abc" });
		expect(JSON.stringify(parseText(`cursor=${cursor}`).after)).toBe(
			`{"v":"${at}","id":"abc"}`,
		);
		const byPriority = encodeCursor({ s: "priority", v: 4, id: "abc" });
		expect(
			JSON.stringify(parseText(`sort=priority&cursor=${byPriority}`).after),
		).toBe('{"v":4,"id":"abc"}');
	});

	it("rejects a cursor made for another sort", () => {
		const cursor = encodeCursor({ s: "-createdAt", v: at, id: "abc" });
		reject(qs(`sort=priority&cursor=${cursor}`));
		const ascending = encodeCursor({ s: "createdAt", v: at, id: "abc" });
		reject(qs(`cursor=${ascending}`));
	});

	it("rejects a value that is not a scalar of the sort field's type", () => {
		reject({ cursor: raw({ s: "-createdAt", v: { $gt: "" }, id: "a" }) });
		reject({ cursor: raw({ s: "-createdAt", v: ["x"], id: "a" }) });
		reject({ cursor: raw({ s: "-createdAt", v: 5, id: "a" }) });
		reject({ cursor: raw({ s: "-createdAt", v: "not a date", id: "a" }) });
		reject({
			sort: "priority",
			cursor: raw({ s: "priority", v: "4", id: "a" }),
		});
		reject({
			sort: "priority",
			cursor: raw({ s: "priority", v: 1.5, id: "a" }),
		});
		reject({
			sort: "flag",
			cursor: raw({ s: "flag", v: "true", id: "a" }),
		});
	});

	it("rejects an id that is not a string, extra or missing members and non-JSON", () => {
		reject({ cursor: raw({ s: "-createdAt", v: at, id: 7 }) });
		reject({ cursor: raw({ s: "-createdAt", v: at, id: { $ne: 1 } }) });
		reject({ cursor: raw({ s: "-createdAt", v: at, id: "a", extra: 1 }) });
		reject({ cursor: raw({ s: "-createdAt", v: at }) });
		reject({ cursor: raw(["-createdAt", at, "a"]) });
		reject({ cursor: raw(null) });
		reject({ cursor: "!!!" });
		reject({ cursor: "" });
		reject({ cursor: Buffer.from("{nope").toString("base64url") });
		reject({ cursor: "A".repeat(5000) });
	});
});

describe("the error", () => {
	const CANARY = "CANARY-7f3a@example.invalid";

	it("never contains the offending key, value or cursor", () => {
		const attempts: Record<string, unknown>[] = [
			{ [CANARY]: "1" },
			{ [`${CANARY}.gte`]: "1" },
			{ priority: CANARY },
			{ "createdAt.gte": CANARY },
			{ status: [CANARY, CANARY] },
			{ status: { [CANARY]: CANARY } },
			{ sort: CANARY },
			{ limit: CANARY },
			{ cursor: CANARY },
			{ cursor: Buffer.from(CANARY).toString("base64url") },
			{ cursor: encodeCursor({ s: CANARY, v: CANARY, id: CANARY }) },
		];
		for (const attempt of attempts) {
			let caught: unknown;
			try {
				parse(attempt);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(ListQueryError);
			const error = caught as ListQueryError;
			const everything = [
				error.message,
				error.stack ?? "",
				JSON.stringify(error),
				JSON.stringify(Object.getOwnPropertyNames(error)),
				Object.values(error).join(" "),
			].join(" ");
			expect(everything).not.toMatch(/canary-7f3a/i);
			expect(everything).not.toMatch(/example\.invalid/i);
		}
	});
});
