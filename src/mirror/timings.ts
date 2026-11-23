import type { Config } from "../config/schema.ts";

export type MirrorTimings = {
	pollMs: number;
	debounceMs: number;
	maxWaitMs: number;
	reconcileMs: number;
	leaseTtlMs: number;
	backoffBaseMs: number;
	backoffMaxMs: number;
};

const DEFAULT_POLL_MS = 1000;
const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_BACKOFF_BASE_MS = 30_000;
const DEFAULT_BACKOFF_MAX_MS = 900_000;

export function resolveTimings(
	mirror: NonNullable<Config["mirror"]>,
	overrides: Partial<MirrorTimings> = {},
): MirrorTimings {
	const debounceMs = mirror.debounceSeconds * 1000;
	const maxWaitMs = mirror.maxWaitSeconds * 1000;
	const reconcileMs = mirror.reconcileMinutes * 60 * 1000;
	return {
		pollMs: overrides.pollMs ?? DEFAULT_POLL_MS,
		debounceMs: overrides.debounceMs ?? debounceMs,
		maxWaitMs: overrides.maxWaitMs ?? maxWaitMs,
		reconcileMs: overrides.reconcileMs ?? reconcileMs,
		leaseTtlMs: overrides.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
		backoffBaseMs: overrides.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
		backoffMaxMs: overrides.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
	};
}
