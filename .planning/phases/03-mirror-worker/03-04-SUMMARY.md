---
phase: 03-mirror-worker
plan: 04
subsystem: api
tags: [mongodb, webdav, mirror, lease, vitest]
requires:
  - phase: 03-01
    provides: MirrorWorker pass, timings, mirror_state
provides:
  - MongoDB mirror_leases with atomic acquire and TTL heartbeat
  - Fence-guarded mirror_state commits
  - Content-hash and ETag skip (D-04) and external-change overwrite (D-03)
affects: [03-05, 03-07, 03-08]
tech-stack:
  added: []
  patterns:
    - "Lease + fencing token before each mirror pass"
    - "Skip PUT when contentHash and lastWrittenEtag match live ETag"
key-files:
  created:
    - src/mirror/lease.ts
    - test/integration/mirror-lease.test.ts
    - test/integration/mirror-skip.test.ts
  modified:
    - src/mirror/state.ts
    - src/mirror/worker.ts
    - src/server.ts
    - test/helpers/mirror.ts
    - test/integration/mirror.test.ts
key-decisions:
  - "Lease acquire filter uses expired/missing lease only (no same-owner re-entrancy) so concurrent acquire races resolve to one holder"
  - "External change is recorded only when the file exists and ETag disagrees with lastWrittenEtag, not on first create or delete-only recovery"
patterns-established:
  - "Pattern 2: acquire → fence → pass → fenced commit → release with heartbeat every TTL/3"
requirements-completed: [MIRR-02, MIRR-03, MIRR-06]
actuals:
  tokens: 92000
  tasks: 2
  commits: 4
plan_head_before: 82c5a8a9a5de8a339125b7071d57cf069a82ca62
plan_head_after: d3dad4398158e2959ac26a483191dc50963978c5
duration: 25min
completed: 2026-11-23
status: complete
---

# Phase 03 Plan 04: Lease, Skip, Multi-Replica Summary

**MongoDB mirror leases with fencing tokens, content-hash skip, and staff edit overwrite (D-03/D-04).**

## Performance

- **Duration:** ~25 min
- **Tasks:** 2/2
- **Commits (03-04):** 4 (`test`×2, `feat`×2)

## Accomplishments

- `MirrorLease` uses atomic `findOneAndUpdate` upsert on `mirror_leases`, treats E11000 as not acquired, heartbeats during passes, and releases to epoch.
- `MirrorStateStore.fence` / fenced `commit` block stale writers; worker logs `mirror pass started`, `mirror unchanged`, `mirror written`, `mirror replaced an external change`, and `mirror commit fenced`.
- Integration tests cover lease race, takeover, fencing, two live instances without overlapping passes, skip-on-unchanged, external replace/delete, and pre-existing non-workbook files.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Lease acquire allowed multiple concurrent wins per owner**
- **Found during:** Task 1
- **Issue:** `{ owner: this.#owner }` in the acquire filter let 10 parallel calls on one `MirrorLease` all succeed.
- **Fix:** Acquire only when `expiresAt <= now` or field missing; heartbeats hold the lease during a pass.
- **Files modified:** `src/mirror/lease.ts`
- **Commit:** `ab435d6`

**2. [Rule 1 - Bug] `mirrorEtag` helper missed namespaced `getetag`**
- **Found during:** Task 2
- **Issue:** PROPFIND responses use `D:getetag`; regex returned null and broke unchanged-skip test.
- **Fix:** Namespace-aware match and strip quotes.
- **Files modified:** `test/helpers/mirror.ts`
- **Commit:** `d3dad43`

**3. [Rule 3 - Blocking] Branch typecheck for array workbook tests**
- **Found during:** Task 1 acceptance
- **Issue:** `WorkbookNotes` lacked `omittedSheets` required by `mirror-workbook-arrays.test.ts`.
- **Fix:** Extended type and initializer only (array sheet implementation remains on other plans).
- **Files modified:** `src/mirror/workbook.ts`
- **Commit:** `ab435d6`

**4. [Rule 1 - Bug] Tracer mirror test could read workbook before record row landed**
- **Found during:** Task 2 verify (batched integration)
- **Fix:** `waitUntil` now waits for `rows[1][0] === body.id`.
- **Files modified:** `test/integration/mirror.test.ts`
- **Commit:** `d3dad43`

## Deferred Issues

- `pnpm test` (unit) still fails on `test/unit/mirror-workbook-arrays.test.ts` — tests from plan 03-03 expect array sheet workbook behaviour not present on this branch's `buildWorkbook` implementation (pre-existing gap). Integration suite for mirror plans passes.

## Self-Check: PASSED

- FOUND: `.planning/phases/03-mirror-worker/03-04-SUMMARY.md`
- FOUND: `src/mirror/lease.ts`
- FOUND: `2758bae` (test lease)
- FOUND: `ab435d6` (feat lease)
- FOUND: `9223db1` (test skip)
- FOUND: `d3dad43` (feat skip)