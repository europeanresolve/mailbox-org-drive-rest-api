import { describe, expect, it } from "vitest";
import { planColumns } from "../../src/mirror/columns.ts";

const sampleSchema = {
	type: "object",
	properties: {
		email: { type: "string" },
		address: {
			type: "object",
			properties: {
				street: { type: "string" },
				country: { type: "string" },
			},
		},
		age: { type: "integer" },
		tags: { type: "array", items: { type: "string" } },
		born: { type: "string", format: "date" },
		seen: { type: "string", format: "date-time" },
	},
} as const;

describe("planColumns", () => {
	it("orders main headers and records array fields", () => {
		const { main, arrays } = planColumns(sampleSchema);
		expect(main.map((c) => c.header)).toEqual([
			"id",
			"email",
			"address.street",
			"address.country",
			"age",
			"born",
			"seen",
			"createdAt",
			"updatedAt",
		]);
		expect(arrays).toHaveLength(1);
		expect(arrays[0]?.path).toEqual(["tags"]);
		expect(arrays[0]?.position).toBe(4);
	});

	it("assigns kinds for scalars and system columns", () => {
		const { main } = planColumns(sampleSchema);
		const kind = (header: string) =>
			main.find((c) => c.header === header)?.kind;
		expect(kind("id")).toBe("string");
		expect(kind("email")).toBe("string");
		expect(kind("age")).toBe("number");
		expect(kind("born")).toBe("date");
		expect(kind("seen")).toBe("date-time");
		expect(kind("createdAt")).toBe("date-time");
		expect(kind("updatedAt")).toBe("date-time");
	});

	it("resolves nullable and multi-type schemas", () => {
		const nullable = planColumns({
			type: "object",
			properties: { x: { type: ["string", "null"] } },
		});
		expect(nullable.main.find((c) => c.header === "x")?.kind).toBe("string");

		const multi = planColumns({
			type: "object",
			properties: { x: { type: ["string", "integer"] } },
		});
		expect(multi.main.find((c) => c.header === "x")?.kind).toBe("json");
	});

	it("maps combiners and empty objects to json columns", () => {
		for (const key of ["anyOf", "oneOf", "allOf", "$ref"] as const) {
			const schema = {
				type: "object",
				properties: { x: { [key]: [] } },
			};
			expect(planColumns(schema).main.find((c) => c.header === "x")?.kind).toBe(
				"json",
			);
		}
		expect(
			planColumns({
				type: "object",
				properties: { bare: { type: "object" } },
			}).main.find((c) => c.header === "bare")?.kind,
		).toBe("json");
		expect(
			planColumns({
				type: "object",
				properties: { noType: {} },
			}).main.find((c) => c.header === "noType")?.kind,
		).toBe("json");
	});

	it("flattens three levels and nests array fields", () => {
		const { main, arrays } = planColumns({
			type: "object",
			properties: {
				a: {
					type: "object",
					properties: {
						b: {
							type: "object",
							properties: { c: { type: "string" } },
						},
					},
				},
				address: {
					type: "object",
					properties: {
						lines: { type: "array", items: { type: "string" } },
					},
				},
			},
		});
		expect(main.map((c) => c.header)).toContain("a.b.c");
		expect(arrays).toEqual([
			expect.objectContaining({ path: ["address", "lines"] }),
		]);
	});

	it("is stable across repeated calls", () => {
		const a = planColumns(sampleSchema);
		const b = planColumns(sampleSchema);
		expect(a).toEqual(b);
	});
});
