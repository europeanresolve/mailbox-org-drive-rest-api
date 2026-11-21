import { STATUS_CODES } from "node:http";
import type { FastifyError, FastifyInstance } from "fastify";
import type { DestinationStream } from "pino";

const UNMATCHED_ROUTE = "(unmatched)";
const PROBLEM_JSON = "application/problem+json";

interface LoggedRequest {
	method: string;
	id: string;
	routeOptions?: { url?: string | undefined };
}

interface LoggedReply {
	statusCode: number;
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function serializeError(error: unknown) {
	const e = (error ?? {}) as Record<string, unknown>;
	const code = stringField(e.code);
	const kind = stringField(e.kind);
	const op = stringField(e.op);
	return {
		type: (error as { constructor?: { name?: string } } | null)?.constructor
			?.name,
		...(code !== undefined ? { code } : {}),
		...(kind !== undefined ? { kind } : {}),
		...(op !== undefined ? { op } : {}),
		...(typeof e.statusCode === "number" ? { status: e.statusCode } : {}),
	};
}

/**
 * Allow-list serializers: only the fields named here can reach the log sink.
 * No URL, query string, headers, body, error message or stack is ever emitted.
 */
export function loggerOptions(level = "info", stream?: DestinationStream) {
	return {
		level,
		...(stream ? { stream } : {}),
		serializers: {
			req: (request: LoggedRequest) => ({
				method: request.method,
				route: request.routeOptions?.url ?? UNMATCHED_ROUTE,
				id: request.id,
			}),
			res: (reply: LoggedReply) => ({ status: reply.statusCode }),
			// Fastify's typings demand message and stack here; omitting them is the point.
			err: serializeError as never,
		},
	};
}

function problem(status: number): {
	type: string;
	title: string;
	status: number;
} {
	return {
		type: "about:blank",
		title: STATUS_CODES[status] ?? "Error",
		status,
	};
}

/** One log line per request, plus problem+json 404 and error responses with no echoed input. */
export function registerLogging(app: FastifyInstance): void {
	app.addHook("onResponse", async (request, reply) => {
		request.log.info(
			{ req: request, res: reply, ms: Math.round(reply.elapsedTime) },
			"request",
		);
	});

	app.setNotFoundHandler(async (_request, reply) => {
		return reply.status(404).type(PROBLEM_JSON).send(problem(404));
	});

	app.setErrorHandler(async (error: FastifyError, request, reply) => {
		const status =
			typeof error.statusCode === "number" &&
			error.statusCode >= 400 &&
			error.statusCode <= 599
				? error.statusCode
				: 500;
		if (status >= 500) {
			request.log.error({ err: error }, "request failed");
		}
		return reply.status(status).type(PROBLEM_JSON).send(problem(status));
	});
}
