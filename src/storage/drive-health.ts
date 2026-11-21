import type { DriveState } from "../http/health.ts";

export interface DriveHealthOptions {
	probe: () => Promise<unknown>;
	ttlMs?: number;
	now?: () => number;
	log?: { warn(fields: Record<string, unknown>, msg: string): void };
}

// RED skeleton: no probing yet, the state never leaves unknown.
export function createDriveHealth(_options: DriveHealthOptions): {
	state(): DriveState;
} {
	return { state: () => "unknown" };
}
