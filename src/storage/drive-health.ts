import type { DriveState } from "../http/health.ts";

export interface DriveHealthOptions {
	probe: () => Promise<unknown>;
	/** How long a probe result is served before a refresh starts (default 30 s). */
	ttlMs?: number;
	now?: () => number;
	log?: { warn(fields: Record<string, unknown>, msg: string): void };
}

function stateOf(error: unknown): DriveState {
	const kind = (error as { kind?: unknown } | null)?.kind;
	return kind === "rate-limited" ? "degraded" : "unavailable";
}

/**
 * Drive state from a cached, single-flight probe. state() never awaits: it
 * returns the cached value and, when none is fresh and none is running, starts
 * one probe in the background. /ready therefore cannot block on, or amplify
 * load onto, the Drive (T-01-29).
 */
export function createDriveHealth(options: DriveHealthOptions): {
	state(): DriveState;
} {
	const { probe, ttlMs = 30_000, now = Date.now, log } = options;
	let current: DriveState = "unknown";
	let checkedAt: number | undefined;
	// Holding the promise is what marks a probe as in flight.
	let inflight: Promise<void> | undefined;

	function settle(next: DriveState, err?: unknown): void {
		checkedAt = now();
		inflight = undefined;
		if (next === current) return;
		current = next;
		try {
			log?.warn(
				err === undefined ? { drive: next } : { err, drive: next },
				"drive state changed",
			);
		} catch {
			// A failing log sink must not become an unhandled rejection.
		}
	}

	return {
		state() {
			const stale = checkedAt === undefined || now() - checkedAt >= ttlMs;
			if (inflight === undefined && stale) {
				// The executor runs the probe now and turns a synchronous throw into a rejection.
				inflight = new Promise<unknown>((resolve) => resolve(probe())).then(
					() => settle("up"),
					(err: unknown) => settle(stateOf(err), err),
				);
			}
			return current;
		},
	};
}
