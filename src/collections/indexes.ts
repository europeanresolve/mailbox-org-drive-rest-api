import type { Db } from "mongodb";
import type { Config } from "../config/schema.ts";

// RED scaffold: behaviour arrives in the GREEN commit.
export async function ensureIndexes(_db: Db, _config: Config): Promise<void> {}

export function scheduleIndexSetup(_options: {
	ensure: () => Promise<void>;
	log: { warn: (fields: object, message: string) => void };
	retryMs: number;
}): { stop(): void } {
	return { stop() {} };
}
