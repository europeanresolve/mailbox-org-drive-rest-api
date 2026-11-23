import type { MirrorState } from "./state.ts";
import type { MirrorTimings } from "./timings.ts";

/** Pure due decision for one mirror_state document (no I/O). */
export function isDue(
	state: MirrorState,
	now: number,
	timings: MirrorTimings,
): boolean {
	const mirroredSeq = state.mirroredSeq ?? 0;
	const dirty = state.dirtySeq > mirroredSeq;
	const reconcile = state.reconcileRequested === true;
	if (!dirty && !reconcile) return false;

	if (
		state.nextAttemptAt !== undefined &&
		now < state.nextAttemptAt.getTime()
	) {
		return false;
	}

	if (reconcile) return true;
	if (state.dueAt !== undefined && now >= state.dueAt.getTime()) return true;
	if (
		state.pendingSince !== undefined &&
		now - state.pendingSince.getTime() >= timings.maxWaitMs
	) {
		return true;
	}
	return false;
}

export function backoffMs(failures: number, timings: MirrorTimings): number {
	const exp = Math.max(0, failures - 1);
	const raw = timings.backoffBaseMs * 2 ** exp;
	return Math.min(raw, timings.backoffMaxMs);
}
