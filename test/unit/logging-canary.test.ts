import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { captureLogs } from "../helpers/log-capture.ts";

// Synthetic personal data. Assertions match the bare token so raw,
// percent-encoded (%40) and JSON-escaped forms are all caught.
const CANARY = "CANARY-7f3a@example.invalid";
const CANARY_PATTERN = /canary-7f3a/i;

describe("logging canary", () => {
	it("logs one PII-free request line for an unmatched path carrying the canary", async () => {
		const logs = captureLogs();
		const app = buildApp({ logger: { level: "info", stream: logs.stream } });
		try {
			const res = await app.inject({
				method: "GET",
				url: `/x/${encodeURIComponent(CANARY)}?q=${CANARY}`,
			});

			expect(res.statusCode).toBe(404);
			expect(res.headers["content-type"]).toMatch(
				/^application\/problem\+json/,
			);
			expect(JSON.parse(res.body)).toEqual({
				type: "about:blank",
				title: "Not Found",
				status: 404,
			});
			expect(res.body).not.toMatch(CANARY_PATTERN);

			const lines = logs.lines();
			expect(lines).toHaveLength(1);
			const entry = JSON.parse(lines[0] as string);
			expect(entry.msg).toBe("request");
			expect(entry.req.method).toBe("GET");
			expect(entry.req.route).toBe("(unmatched)");
			expect(entry.res.status).toBe(404);
			expect(typeof entry.ms).toBe("number");
			expect(lines.join("\n")).not.toMatch(CANARY_PATTERN);
		} finally {
			await app.close();
		}
	});
});
