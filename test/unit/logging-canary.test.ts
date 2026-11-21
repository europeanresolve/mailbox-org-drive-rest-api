import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.ts";
import { captureLogs, type LogCapture } from "../helpers/log-capture.ts";

// Synthetic personal data. Assertions match the bare token so raw,
// percent-encoded (%40) and JSON-escaped forms are all caught.
const CANARY = "CANARY-7f3a@example.invalid";
const CANARY_PATTERN = /canary-7f3a/i;

interface LogLine {
	msg: string;
	req?: { method: string; route: string; id: string };
	res?: { status: number };
	err?: Record<string, unknown>;
	ms?: number;
}

function parse(logs: LogCapture): LogLine[] {
	return logs.lines().map((line) => JSON.parse(line) as LogLine);
}

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

	describe("every HTTP error path in this phase", () => {
		let app: FastifyInstance;
		let logs: LogCapture;
		let requests = 0;
		const bodies: string[] = [];

		async function send(opts: Parameters<FastifyInstance["inject"]>[0]) {
			const before = logs.lines().length;
			requests += 1;
			const res = await app.inject(opts);
			bodies.push(res.body);
			return { res, lines: parse(logs).slice(before) };
		}

		function expectClean(res: { body: string }, lines: LogLine[]) {
			expect(res.body).not.toMatch(CANARY_PATTERN);
			expect(JSON.stringify(lines)).not.toMatch(CANARY_PATTERN);
		}

		beforeAll(() => {
			logs = captureLogs();
			app = buildApp({ logger: { level: "info", stream: logs.stream } });
			app.get("/boom", async () => {
				throw new Error(CANARY);
			});
			app.post(
				"/echo",
				{
					bodyLimit: 64,
					schema: {
						body: {
							type: "object",
							properties: { name: { type: "string", maxLength: 5 } },
							required: ["name"],
							additionalProperties: false,
						},
					},
				},
				async () => ({ ok: true }),
			);
		});

		afterAll(async () => {
			await app.close();
		});

		it("thrown error: 500 problem+json, error line carries type only", async () => {
			const { res, lines } = await send({ method: "GET", url: "/boom" });

			expect(res.statusCode).toBe(500);
			expect(res.headers["content-type"]).toMatch(
				/^application\/problem\+json/,
			);
			expect(JSON.parse(res.body)).toEqual({
				type: "about:blank",
				title: "Internal Server Error",
				status: 500,
			});
			expect(lines).toHaveLength(2);
			const failed = lines.find((l) => l.msg === "request failed");
			expect(failed?.err?.type).toBe("Error");
			expect(failed?.err).not.toHaveProperty("message");
			expect(failed?.err).not.toHaveProperty("stack");
			const request = lines.find((l) => l.msg === "request");
			expect(request?.req?.route).toBe("/boom");
			expectClean(res, lines);
		});

		it("schema-invalid body: 400 without an error line", async () => {
			const { res, lines } = await send({
				method: "POST",
				url: "/echo",
				payload: { name: CANARY },
			});

			expect(res.statusCode).toBe(400);
			expect(JSON.parse(res.body)).toEqual({
				type: "about:blank",
				title: "Bad Request",
				status: 400,
			});
			expect(lines).toHaveLength(1);
			expect(lines[0]?.req?.route).toBe("/echo");
			expectClean(res, lines);
		});

		it("truncated JSON body: 400", async () => {
			const { res, lines } = await send({
				method: "POST",
				url: "/echo",
				headers: { "content-type": "application/json" },
				payload: '{"name":"CANARY-7f3a',
			});

			expect(res.statusCode).toBe(400);
			expect(lines).toHaveLength(1);
			expect(lines[0]?.req?.route).toBe("/echo");
			expectClean(res, lines);
		});

		it("text/plain body hits the default string parser and fails the schema: 400", async () => {
			const { res, lines } = await send({
				method: "POST",
				url: "/echo",
				headers: { "content-type": "text/plain" },
				payload: CANARY,
			});

			expect(res.statusCode).toBe(400);
			expect(lines).toHaveLength(1);
			expectClean(res, lines);
		});

		it("wrong content type with no parser: 415", async () => {
			const { res, lines } = await send({
				method: "POST",
				url: "/echo",
				headers: { "content-type": "application/xml" },
				payload: `<name>${CANARY}</name>`,
			});

			expect(res.statusCode).toBe(415);
			expect(lines).toHaveLength(1);
			expectClean(res, lines);
		});

		it("oversize body: 413", async () => {
			const { res, lines } = await send({
				method: "POST",
				url: "/echo",
				headers: { "content-type": "application/json" },
				payload: JSON.stringify({ name: CANARY, pad: "x".repeat(200) }),
			});

			expect(res.statusCode).toBe(413);
			expect(lines).toHaveLength(1);
			expectClean(res, lines);
		});

		it("query string on a matched route: 200, route template only", async () => {
			const { res, lines } = await send({
				method: "GET",
				url: `/health?email=${CANARY}`,
			});

			expect(res.statusCode).toBe(200);
			expect(lines).toHaveLength(1);
			expect(lines[0]?.req?.route).toBe("/health");
			expectClean(res, lines);
		});

		it("client-supplied x-request-id is ignored", async () => {
			const { res, lines } = await send({
				method: "GET",
				url: "/health",
				headers: { "x-request-id": CANARY },
			});

			expect(lines).toHaveLength(1);
			expect(lines[0]?.req?.id).toBeTypeOf("string");
			expect(lines[0]?.req?.id).not.toBe(CANARY);
			expectClean(res, lines);
		});

		it("line count is requests plus 5xx error lines, every request line has a route template", () => {
			const lines = parse(logs);
			const failures = lines.filter((l) => l.msg === "request failed");
			const requestLines = lines.filter((l) => l.msg === "request");

			expect(failures).toHaveLength(1);
			expect(lines).toHaveLength(requests + failures.length);
			expect(requestLines).toHaveLength(requests);
			for (const line of requestLines) {
				expect(line.req?.route).toMatch(/^\/|^\(unmatched\)$/);
			}
			expect(logs.lines().join("\n")).not.toMatch(CANARY_PATTERN);
			expect(bodies.join("\n")).not.toMatch(CANARY_PATTERN);
		});
	});
});
