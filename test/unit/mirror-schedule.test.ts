import { describe, expect, it } from "vitest";
import { backoffMs, isDue } from "../../src/mirror/schedule.ts";
import type { MirrorState } from "../../src/mirror/state.ts";
import type { MirrorTimings } from "../../src/mirror/timings.ts";

const timings: MirrorTimings = {
	pollMs: 50,
	debounceMs: 300,
	maxWaitMs: 800,
	reconcileMs: 60_000,
	leaseTtlMs: 60_000,
	backoffBaseMs: 30_000,
	backoffMaxMs: 900_000,
};

function state(partial: Partial<MirrorState> & { _id: string }): MirrorState {
	return {
		dirtySeq: 0,
		mirroredSeq: 0,
		dueAt: new Date(0),
		...partial,
	};
}

describe("isDue", () => {
	const now = 1_000_000;

	it("is never due when clean and no reconcile flag", () => {
		expect(
			isDue(
				state({
					_id: "c",
					dirtySeq: 1,
					mirroredSeq: 1,
					dueAt: new Date(now - 1),
				}),
				now,
				timings,
			),
		).toBe(false);
	});

	it("respects debounce when max wait has not elapsed", () => {
		expect(
			isDue(
				state({
					_id: "c",
					dirtySeq: 1,
					mirroredSeq: 0,
					dueAt: new Date(now + 500),
					pendingSince: new Date(now - 100),
				}),
				now,
				timings,
			),
		).toBe(false);
	});

	it("is due when max wait has elapsed even if dueAt is future", () => {
		expect(
			isDue(
				state({
					_id: "c",
					dirtySeq: 1,
					mirroredSeq: 0,
					dueAt: new Date(now + 500),
					pendingSince: new Date(now - 900),
				}),
				now,
				timings,
			),
		).toBe(true);
	});

	it("is due when dueAt is in the past", () => {
		expect(
			isDue(
				state({
					_id: "c",
					dirtySeq: 1,
					mirroredSeq: 0,
					dueAt: new Date(now - 1),
				}),
				now,
				timings,
			),
		).toBe(true);
	});

	it("is not due when nextAttemptAt is in the future", () => {
		expect(
			isDue(
				state({
					_id: "c",
					dirtySeq: 1,
					mirroredSeq: 0,
					dueAt: new Date(now - 1),
					nextAttemptAt: new Date(now + 60_000),
				}),
				now,
				timings,
			),
		).toBe(false);
	});

	it("is due on reconcileRequested even when seqs match", () => {
		expect(
			isDue(
				state({
					_id: "c",
					dirtySeq: 0,
					mirroredSeq: 0,
					reconcileRequested: true,
				}),
				now,
				timings,
			),
		).toBe(true);
	});

	it("reconcile is blocked by nextAttemptAt", () => {
		expect(
			isDue(
				state({
					_id: "c",
					dirtySeq: 0,
					mirroredSeq: 0,
					reconcileRequested: true,
					nextAttemptAt: new Date(now + 1),
				}),
				now,
				timings,
			),
		).toBe(false);
	});

	it("treats missing mirroredSeq as zero on a fresh upsert", () => {
		expect(
			isDue(
				{
					_id: "c",
					dirtySeq: 1,
					dueAt: new Date(now - 1),
				} as MirrorState,
				now,
				timings,
			),
		).toBe(true);
	});
});

describe("backoffMs", () => {
	const base = 30_000;
	const max = 900_000;

	it("doubles per failure count capped at max", () => {
		expect(backoffMs(1, timings)).toBe(base);
		expect(backoffMs(2, timings)).toBe(base * 2);
		expect(backoffMs(3, timings)).toBe(base * 4);
		expect(backoffMs(20, timings)).toBe(max);
	});
});
