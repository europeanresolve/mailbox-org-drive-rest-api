import { setTimeout as sleep } from "node:timers/promises";
import pLimit from "p-limit";
import pRetry from "p-retry";
import { createClient, type FileStat, type WebDAVClient } from "webdav";
import type { ReadOptions, StatEntry, StorageAdapter } from "./adapter.ts";
import { StorageError, type StorageErrorKind } from "./errors.ts";
import type { ResolvedPath } from "./mounts.ts";

export type WebDavAdapterOptions = {
	url: string;
	username: string;
	password: string;
	/** Parallel requests (default 2). A slot is held across retries and backoff. */
	concurrency?: number;
	retry?: {
		retries?: number;
		minTimeout?: number;
		maxTimeout?: number;
		maxRetryTime?: number;
	};
	timeouts?: { metaMs?: number; dataMs?: number };
	/** After a 401 the adapter fails fast with unauthorized for this long (default 60 s). */
	cooldownMs?: number;
	/** Largest Retry-After that is waited out (default 30 s); a larger one gives rate-limited. */
	maxRetryAfterMs?: number;
};

const DEFAULTS = {
	concurrency: 2,
	retries: 4,
	minTimeout: 500,
	maxTimeout: 8000,
	maxRetryTime: 60_000,
	metaMs: 15_000,
	dataMs: 60_000,
	cooldownMs: 60_000,
	maxRetryAfterMs: 30_000,
} as const;

const CLIENT_BODY_CAP = 64 * 1024 * 1024;

// Explicit four-prop body: without it the client sends an empty PROPFIND
// (allprop), which is bulky on OX.
const PROPFIND_BODY =
	'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>';
const PROPFIND_OPTIONS = {
	data: PROPFIND_BODY,
	headers: { "Content-Type": "application/xml" },
} as const;

const NETWORK_CODES = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"EAI_AGAIN",
	"EPIPE",
	"ENOTFOUND",
]);

/**
 * Internal classification of one failed attempt. It carries numbers and a
 * kind only: the raw library error embeds the request URL (a folder name), so
 * it is dropped here and never kept as a cause.
 */
class Failure extends Error {
	readonly kind: StorageErrorKind;
	readonly status: number | undefined;
	readonly retryable: boolean;
	/** True when the request may or may not have reached the server. */
	readonly network: boolean;
	/** Server-requested wait before a retry, when it sent Retry-After. */
	readonly retryAfterMs: number | undefined;

	constructor(
		kind: StorageErrorKind,
		status: number | undefined,
		retryable: boolean,
		network: boolean,
		retryAfterMs?: number,
	) {
		super("webdav attempt failed");
		this.name = "Failure";
		this.kind = kind;
		this.status = status;
		this.retryable = retryable;
		this.network = network;
		this.retryAfterMs = retryAfterMs;
	}
}

/** Retry-After as delta-seconds or an HTTP date, in ms; undefined when absent or invalid. */
function retryAfterOf(raw: unknown): number | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const headers = (raw as { response?: { headers?: { get?: unknown } } })
		.response?.headers;
	if (typeof headers?.get !== "function") return undefined;
	const value = (headers as { get(name: string): string | null }).get(
		"retry-after",
	);
	if (value === null) return undefined;
	const text = value.trim();
	if (/^\d+$/.test(text)) return Number(text) * 1000;
	const date = Date.parse(text);
	return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function statusOf(raw: unknown): number | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const status = (raw as { status?: unknown }).status;
	return typeof status === "number" ? status : undefined;
}

function codeOf(raw: unknown): string | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const holder = raw as { code?: unknown; cause?: { code?: unknown } };
	const code = holder.code ?? holder.cause?.code;
	return typeof code === "string" ? code : undefined;
}

function classify(raw: unknown, signal: AbortSignal): Failure {
	const status = statusOf(raw);
	if (status !== undefined) {
		switch (status) {
			case 401:
				return new Failure("unauthorized", status, false, false);
			case 403:
				return new Failure("forbidden", status, false, false);
			case 404:
				return new Failure("not-found", status, false, false);
			case 405:
			case 409:
			case 412:
			case 423:
				return new Failure("conflict", status, false, false);
			case 413:
				return new Failure("too-large", status, false, false);
			case 507:
				return new Failure("insufficient-storage", status, false, false);
			case 429:
				return new Failure(
					"rate-limited",
					status,
					true,
					false,
					retryAfterOf(raw),
				);
			case 502:
			case 503:
			case 504:
				return new Failure(
					"unavailable",
					status,
					true,
					false,
					retryAfterOf(raw),
				);
			default:
				return new Failure("unavailable", status, false, false);
		}
	}
	const code = codeOf(raw);
	if (signal.aborted || (code !== undefined && NETWORK_CODES.has(code))) {
		return new Failure("unavailable", undefined, true, true);
	}
	return new Failure("unavailable", undefined, false, false);
}

function toEntry(file: FileStat, name: string): StatEntry {
	const isDir = file.type === "directory";
	const modified = new Date(file.lastmod);
	return {
		name,
		kind: isDir ? "dir" : "file",
		size: !isDir && Number.isFinite(file.size) ? file.size : 0,
		etag: file.etag ?? null,
		lastModified: Number.isNaN(modified.getTime()) ? null : modified,
	};
}

const clientPath = (p: ResolvedPath): string => `/${p.segments.join("/")}`;

const notImplemented = (op: string): never => {
	throw new StorageError("unavailable", op);
};

/** StorageAdapter over the `webdav` client with a concurrency cap and bounded retry. */
export class WebDavAdapter implements StorageAdapter {
	readonly #client: WebDAVClient;
	readonly #limit: ReturnType<typeof pLimit>;
	readonly #retry: {
		retries: number;
		minTimeout: number;
		maxTimeout: number;
		maxRetryTime: number;
	};
	readonly #metaMs: number;
	readonly #dataMs: number;
	readonly #cooldownMs: number;
	readonly #maxRetryAfterMs: number;
	#cooldownUntil = 0;

	constructor(options: WebDavAdapterOptions) {
		this.#client = createClient(options.url, {
			username: options.username,
			password: options.password,
			headers: { "User-Agent": "mailbox-org-drive-rest-api" },
			maxContentLength: CLIENT_BODY_CAP,
			maxBodyLength: CLIENT_BODY_CAP,
			entityDecoder: {
				limit: { maxTotalExpansions: 1000, maxExpandedLength: 1_000_000 },
			},
		});
		this.#limit = pLimit(options.concurrency ?? DEFAULTS.concurrency);
		this.#retry = {
			retries: options.retry?.retries ?? DEFAULTS.retries,
			minTimeout: options.retry?.minTimeout ?? DEFAULTS.minTimeout,
			maxTimeout: options.retry?.maxTimeout ?? DEFAULTS.maxTimeout,
			maxRetryTime: options.retry?.maxRetryTime ?? DEFAULTS.maxRetryTime,
		};
		this.#metaMs = options.timeouts?.metaMs ?? DEFAULTS.metaMs;
		this.#dataMs = options.timeouts?.dataMs ?? DEFAULTS.dataMs;
		this.#cooldownMs = options.cooldownMs ?? DEFAULTS.cooldownMs;
		this.#maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULTS.maxRetryAfterMs;
	}

	/** After a 401 no request is sent until the cooldown ends (T-01-23). */
	#assertNotCoolingDown(op: string): void {
		if (Date.now() < this.#cooldownUntil) {
			throw new StorageError("unauthorized", op, 401);
		}
	}

	/** One raw client call with its own timeout; any failure becomes a Failure. */
	async #call<T>(
		timeoutMs: number,
		fn: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const signal = AbortSignal.timeout(timeoutMs);
		try {
			return await fn(signal);
		} catch (raw) {
			const failure = classify(raw, signal);
			if (failure.kind === "unauthorized") {
				this.#cooldownUntil = Date.now() + this.#cooldownMs;
			}
			throw failure;
		}
	}

	/** limit(() => pRetry(...)): the slot is held across retries and backoff. */
	#run<T>(op: string, attempt: () => Promise<T>): Promise<T> {
		this.#assertNotCoolingDown(op);
		const cap = this.#maxRetryAfterMs;
		return this.#limit(async () => {
			try {
				// A call queued behind a 401 must not send its request either.
				this.#assertNotCoolingDown(op);
				return await pRetry(attempt, {
					...this.#retry,
					factor: 2,
					randomize: true,
					shouldRetry: ({ error }) =>
						error instanceof Failure &&
						error.retryable &&
						(error.retryAfterMs ?? 0) <= cap,
					// Wait out Retry-After inside the slot, but never beyond the cap.
					onFailedAttempt: async ({ error, retryDelay }) => {
						if (!(error instanceof Failure) || !error.retryable) return;
						const wanted = error.retryAfterMs;
						if (wanted === undefined || wanted > cap || retryDelay === 0)
							return;
						if (wanted > retryDelay) await sleep(wanted - retryDelay);
					},
				});
			} catch (error) {
				if (error instanceof StorageError) throw error;
				if (error instanceof Failure) {
					// A Retry-After above the cap is not held: the caller sees rate-limited.
					const kind =
						error.retryable && (error.retryAfterMs ?? 0) > cap
							? "rate-limited"
							: error.kind;
					throw new StorageError(kind, op, error.status);
				}
				throw new StorageError("unavailable", op);
			}
		});
	}

	async stat(p: ResolvedPath): Promise<StatEntry> {
		const name = p.segments.at(-1) ?? "";
		return this.#run("stat", async () => {
			const file = await this.#call(this.#metaMs, (signal) =>
				this.#client.stat(clientPath(p), { ...PROPFIND_OPTIONS, signal }),
			);
			return toEntry(file as FileStat, name);
		});
	}

	async list(_p: ResolvedPath): Promise<StatEntry[]> {
		return notImplemented("list");
	}

	async read(_p: ResolvedPath, _opts?: ReadOptions): Promise<Buffer> {
		return notImplemented("read");
	}

	async write(_p: ResolvedPath, _body: Buffer): Promise<StatEntry> {
		return notImplemented("write");
	}

	async mkdir(_p: ResolvedPath): Promise<void> {
		return notImplemented("mkdir");
	}

	async move(
		_from: ResolvedPath,
		_to: ResolvedPath,
		_opts: { overwrite: boolean },
	): Promise<void> {
		return notImplemented("move");
	}

	async delete(_p: ResolvedPath): Promise<void> {
		return notImplemented("delete");
	}
}
