import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type RecordedRequest = {
	method: string;
	/** Raw request target, still percent-encoded. */
	path: string;
	depth: string | undefined;
	headers: IncomingHttpHeaders;
	body: string;
};

export type FakeReply =
	| {
			status?: number;
			headers?: Record<string, string>;
			body?: string;
			/** Wait before answering, to hold a request in flight. */
			delayMs?: number;
	  }
	| "destroy";
// A reply without a status is layered over the default reply, so
// `{ delayMs: 50 }` alone delays the normal answer.

/** Receives each request and its 1-based index; undefined means the default reply. */
export type Responder = (
	req: RecordedRequest,
	index: number,
) => FakeReply | undefined;

export type FakeWebDav = {
	/** Base URL with a trailing slash. */
	url: string;
	requests: RecordedRequest[];
	/** Highest number of requests seen in flight at once. */
	readonly maxInFlight: number;
	script(responder: Responder): void;
	close(): Promise<void>;
};

const MODIFIED = "Sat, 21 Nov 2026 16:00:00 GMT";

function entry(href: string, isDir: boolean, size: number): string {
	const type = isDir ? "<D:collection/>" : "";
	return (
		`<D:response><D:href>${href}</D:href><D:propstat><D:prop>` +
		`<D:resourcetype>${type}</D:resourcetype>` +
		`<D:getetag>"synthetic-etag"</D:getetag>` +
		`<D:getlastmodified>${MODIFIED}</D:getlastmodified>` +
		`<D:getcontentlength>${size}</D:getcontentlength>` +
		`</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
	);
}

function multistatus(inner: string): string {
	return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${inner}</D:multistatus>`;
}

/** Default reply: Depth 1 lists the target as a folder with one child; Depth 0 is a 9-byte file. */
function defaultReply(req: RecordedRequest): Exclude<FakeReply, "destroy"> {
	switch (req.method) {
		case "PROPFIND": {
			if (req.depth === "1") {
				const self = req.path.endsWith("/") ? req.path : `${req.path}/`;
				return {
					status: 207,
					headers: { "Content-Type": "application/xml; charset=utf-8" },
					body: multistatus(
						entry(self, true, 0) + entry(`${self}child.txt`, false, 9),
					),
				};
			}
			return {
				status: 207,
				headers: { "Content-Type": "application/xml; charset=utf-8" },
				body: multistatus(entry(req.path, false, 9)),
			};
		}
		case "GET":
			return { status: 200, body: "synthetic" };
		case "PUT":
		case "MKCOL":
		case "MOVE":
			return { status: 201 };
		case "DELETE":
			return { status: 204 };
		default:
			return { status: 405 };
	}
}

function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
		req.on("error", () => resolve(""));
	});
}

function send(res: ServerResponse, reply: Exclude<FakeReply, "destroy">): void {
	if (res.destroyed) return;
	res.writeHead(reply.status ?? 200, reply.headers ?? {});
	res.end(reply.body ?? "");
}

/**
 * In-process node:http WebDAV fake on 127.0.0.1 with scripted faults, request
 * recording and in-flight counting. Names in default replies are synthetic.
 */
export async function startFakeWebDav(): Promise<FakeWebDav> {
	const requests: RecordedRequest[] = [];
	let responder: Responder = () => undefined;
	let inFlight = 0;
	let maxInFlight = 0;

	const server = createServer((req, res) => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		res.on("close", () => {
			inFlight--;
		});
		void readBody(req).then((body) => {
			const recorded: RecordedRequest = {
				method: req.method ?? "",
				path: req.url ?? "",
				depth: req.headers.depth as string | undefined,
				headers: req.headers,
				body,
			};
			requests.push(recorded);
			const scripted = responder(recorded, requests.length);
			const reply =
				scripted === undefined
					? defaultReply(recorded)
					: scripted === "destroy" || scripted.status !== undefined
						? scripted
						: { ...defaultReply(recorded), ...scripted };
			if (reply === "destroy") {
				req.socket.destroy();
				return;
			}
			if (reply.delayMs !== undefined) {
				setTimeout(() => send(res, reply), reply.delayMs);
				return;
			}
			send(res, reply);
		});
	});

	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}/`,
		requests,
		get maxInFlight() {
			return maxInFlight;
		},
		script(next) {
			responder = next;
		},
		close() {
			return new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
		},
	};
}
