---
phase: 03-mirror-worker
plan: 05
subsystem: mirror
tags: [debounce, reconcile, backoff, mirror-worker]
requires:
  - phase: 03-04
    provides: Lease fencing, hash/etag skip on mirror pass
provides:
  - Pure isDue/backoffMs scheduling (D-15, D-16)
  - pendingSince sliding debounce with max wait
  - Boot and periodic reconcile sweeps
  - Drive failure backoff with enumerated lastError codes
affects: [03-06, 03-07, 03-08]

actuals:
  tokens: 92000
  tasks: 3
  commits: 8

tech-stack:
  added: []
  patterns:
    - "isDue pure schedule with reconcile and nextAttemptAt gates"
    - "Fenced recordFailure with exponential backoff between mirror attempts"

key-files:
  created:
    - src/mirror/schedule.ts
    - test/unit/mirror-schedule.test.ts
    - test/integration/mirror-debounce.test.ts
    - test/integration/mirror-recovery.test.ts
  modified:
    - src/mirror/timings.ts
    - src/mirror/state.ts
    - src/mirror/worker.ts
    - test/integration/mirror-skip.test.ts

key-decisions:
  - "Non-xlsx bytes on the mirror mount bypass hash/etag skip and count as external drift"
  - "Success commit clears reconcile, failures, nextAttemptAt in the same fenced update"

patterns-established:
  - "pendingSince: $min on markDirty, cleared or rolled forward on fenced commit"

requirements-completed: [MIRR-01, MIRR-07]

duration: 23min
completed: 2026-11-23
status: complete
plan_head_before: e1277b9b44ba169d003561afef974709c92fe767
plan_head_after: 4bf8864a38b803b9c792985ece6ba7e25ad2f97b
---

# Phase 03 Plan 05: Debounce, Reconcile, Backoff Summary

**Sliding debounce with max wait, automatic reconcile sweeps, and exponential backoff on Drive failures — all driven by pure `isDue` scheduling.**

## Performance

- **Duration:** 23 min
- **Tasks:** 3/3
- **Commits:** 7 (measured from plan base)

## Accomplishments

- `isDue` / `backoffMs` in `schedule.ts` with unit coverage for debounce, max-wait, reconcile, and retry timing (MIRR-01).
- `pendingSince` on dirty marks; worker tick uses `isDue`; bursty writes coalesce (integration debounce tests).
- Boot + periodic `requestReconcile`, crash/behind-API recovery, unchanged reconcile skip, and fenced `recordFailure` with enumerated `lastError` (MIRR-07).

## Task Commits

1. **Task 1: Pure due decision and backoff** — `ae94aa1` (test), `95f5f9e` (feat)
2. **Task 2: Sliding debounce with max wait** — `b1c2e3d` (test), `d4ede81` (feat)
3. **Task 3: Reconcile and failure recovery** — `b6fa96a` (test), `b883a91` (feat)
4. **Rule 1 follow-up: tampered-file skip guard** — `24386ab` (fix)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] ETag/hash skip could ignore plain-text tampering**
- **Found during:** Task 3 verification (mirror-skip under load)
- **Issue:** Stale etag equality allowed skip while the on-disk file was not a workbook
- **Fix:** Before skip on a dirty bump, read mount bytes; non-ZIP payload forces rewrite and `externalChanges` accounting
- **Files modified:** `src/mirror/worker.ts`, `test/integration/mirror-skip.test.ts`
- **Commit:** `24386ab`

## TDD Gate Compliance

| Task | RED (test commit) | GREEN (feat commit) |
|------|-------------------|---------------------|
| 1 | ae94aa1 | 95f5f9e |
| 2 | b1c2e3d | d4ede81 |
| 3 | b6fa96a | b883a91 |

## Self-Check: PASSED

- `src/mirror/schedule.ts` — FOUND
- `test/integration/mirror-debounce.test.ts` — FOUND
- `test/integration/mirror-recovery.test.ts` — FOUND
- Commits ae94aa1, 95f5f9e, b1c2e3d, d4ede81, b6fa96a, b883a91, 24386ab — FOUND on branch