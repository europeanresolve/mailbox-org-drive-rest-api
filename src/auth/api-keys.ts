import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config/schema.ts";
import { PROBLEM_JSON, problem } from "../http/logging.ts";

export const KEY_PREFIX = "mdra_";
const KEY_PATTERN = /^mdra_[A-Za-z0-9_-]{43}$/;

export type ResolvedKey = {
	name: string;
	grants: ReadonlySet<string>;
};

/** Route code depends on this interface only, so a MongoDB-backed store can replace the config one (D-01). */
export interface KeyStore {
	resolve(rawKey: string): Promise<ResolvedKey | null>;
}

/** Lowercase SHA-256 hex of the whole key, prefix included. */
export function hashKey(key: string): string {
	return createHash("sha256").update(key).digest("hex");
}

export class ConfigKeyStore implements KeyStore {
	readonly #entries: readonly {
		name: string;
		hash: Buffer;
		grants: ReadonlySet<string>;
	}[];

	constructor(keys: Config["apiKeys"]) {
		this.#entries = keys.map((key) => ({
			name: key.name,
			hash: Buffer.from(key.hash, "hex"),
			grants: new Set(key.grants),
		}));
	}

	async resolve(rawKey: string): Promise<ResolvedKey | null> {
		if (!KEY_PATTERN.test(rawKey)) return null;
		const presented = Buffer.from(hashKey(rawKey), "hex");
		let match: ResolvedKey | null = null;
		// Every configured hash is compared, so timing does not reveal which key matched.
		for (const entry of this.#entries) {
			if (timingSafeEqual(presented, entry.hash)) {
				match = { name: entry.name, grants: entry.grants };
			}
		}
		return match;
	}
}

/** The token after `Bearer` (scheme case-insensitive), or null for anything not exactly scheme plus one token. */
function bearerToken(header: string | undefined): string | null {
	if (header === undefined) return null;
	const parts = header.split(" ");
	const [scheme, token] = parts;
	if (parts.length !== 2 || scheme?.toLowerCase() !== "bearer") return null;
	return token === undefined || token === "" ? null : token;
}

/**
 * onRequest hook for an apiKey operation: 401 for a missing, malformed or unknown
 * key, 403 for a key without the exact `collection:operation` grant. Running
 * before body parsing means an unauthorised body is never read.
 */
export function requireGrant(
	keyStore: KeyStore,
	collection: string,
	operation: string,
) {
	return async (
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<FastifyReply | undefined> => {
		const token = bearerToken(request.headers.authorization);
		const key = token === null ? null : await keyStore.resolve(token);
		if (key === null) {
			return reply
				.status(401)
				.header("www-authenticate", "Bearer")
				.type(PROBLEM_JSON)
				.send(problem(401));
		}
		if (!key.grants.has(`${collection}:${operation}`)) {
			return reply.status(403).type(PROBLEM_JSON).send(problem(403));
		}
		return undefined;
	};
}
