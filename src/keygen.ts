import { randomBytes } from "node:crypto";
import { hashKey, KEY_PREFIX } from "./auth/api-keys.ts";

/** `mdra_` plus 43 base64url characters (32 random bytes). */
export function generateKey(): string {
	return `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

if (import.meta.main) {
	const key = generateKey();
	// The one place a raw key is ever shown: it is not stored anywhere.
	process.stdout.write(`key: ${key}\nhash: ${hashKey(key)}\n`);
}
