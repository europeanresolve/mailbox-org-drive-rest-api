---
phase: 03-mirror-worker
plan: 01
subsystem: mirror
tags: [exceljs, mirror, webdav, worker, role, tdd]
requires:
  - phase: 02-collections
    provides: collections routes, record store, hardened create path
provides:
  - mirror config contract (option A) and startup validation
  - exceljs-only workbook build, MirrorWorker direct PUT tracer
  - ROLE api/worker/all split and dirty marks on writes
affects: [03-02, 03-04, 03-05, 03-07]

actuals:
  tokens: 98000
  tasks: 3
  commits: 2
plan_head_before: 9f5198435060c3e7b5c3c58fa7c8cc1171d9b90c
plan_head_after: ba29de61906e98ba36a9fc1f0cc1aa2115de00ce

tech-stack:
  added: [exceljs@4.4.0]
  patterns:
    - mirror_state dirtySeq sliding debounce
    - exceljs quarantined in src/mirror/workbook.ts
    - ROLE via env only

key-files:
  created:
    - src/mirror/path.ts
    - src/mirror/timings.ts
    - src/mirror/state.ts
    - src/mirror/workbook.ts
    - src/mirror/worker.ts
    - test/helpers/mirror.ts
    - test/integration/mirror.test.ts
    - test/unit/mirror-config.test.ts
  modified:
    - src/server.ts
    - src/config/load.ts
    - src/config/schema.ts
    - src/collections/routes.ts

key-decisions:
  - "D-05 mirror config contract: option A (debounceSeconds, maxWaitSeconds, reconcileMinutes, maxCellLength)"
  - "Direct PUT only; exceljs confined to workbook.ts"

requirements-completed: [MIRR-01, MIRR-03, MIRR-04, FND-05]

coverage:
  - id: D1
    description: "API create marks mirror_state dirty and worker writes contact.xlsx via direct PUT"
    requirement: MIRR-01
    verification:
      - kind: integration
        ref: test/integration/mirror.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: "Deployments with collections require a writable mirror mount"
    requirement: MIRR-03
    verification:
      - kind: unit
        ref: test/unit/mirror-config.test.ts
        status: pass
    human_judgment: false

duration: 7min
completed: 2026-11-23
status: complete
---

# Phase 03 Plan 01: Mirror tracer slice Summary

**End-to-end mirror tracer: dirty mark, exceljs workbook, direct PUT, ROLE, and mandatory mirror config.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-11-23T05:08:13Z
- **Completed:** 2026-11-23T05:15:00Z
- **Tasks:** 3/3
- **Files modified:** 27

## Task 1 decision

**User contract (option A):** `mirror: { mount, debounceSeconds: 15, maxWaitSeconds: 180, reconcileMinutes: 15, maxCellLength: 32767 }` with only `mount` required when collections exist. Confirmed from Phase 03 discussion (D-05).

## TDD Gate Compliance

| Task | RED commit | GREEN commit | Evidence |
|------|------------|--------------|----------|
| Task 2 tracer | d713bc2 test(03-01) | ba29de6 feat(03-01) | integration mirror.test.ts exercised before worker shipped |
| Task 3 config | (included in d713bc2 mirror-config.test.ts) | ba29de6 feat(03-01) | mirror-config unit suite green after mirrorIssues |

## Accomplishments

- Installed `exceljs@4.4.0` with build confined to `src/mirror/workbook.ts`.
- Added `MirrorWorker` poll loop, `MirrorStateStore.markDirty`, and route hooks after successful writes.
- Enforced `mirror.REQUIRED`, mount writability, and `ROLE` parsing; updated example config and fixtures.
- Reworded MIRR-03/MIRR-04 and Phase 3 success criteria 1 and 3 for direct PUT and schema column order.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Nested live/mirror mount overlap in collectionsApp**

- **Found during:** Task 2
- **Issue:** `live` at `/run-id` overlapped dedicated `mirror` mount and failed `mount.OVERLAP`.
- **Fix:** Use sibling paths (`/run-id/live` and `/run-id/m-<db>`) when `mirror: true`.
- **Files:** test/helpers/collections-app.ts
- **Commit:** ba29de6

**2. [Rule 1 - Bug] collections-write race harness missing mirror block**

- **Found during:** Task 3 verification
- **Issue:** `mirror.REQUIRED` broke inline `loadConfig` in PATCH race test.
- **Fix:** Add `mirror: { mount: live }` and bounded `name` string.
- **Files:** test/integration/collections-write.test.ts
- **Commit:** ba29de6

None other — plan executed with the above fixes.

## Commits

| Commit | Message |
|--------|---------|
| d713bc2 | test(03-01): add mirror integration and config tests |
| ba29de6 | feat(03-01): mirror tracer slice with config contract and ROLE |

## Self-Check: PASSED

- `03-01-SUMMARY.md` present
- Commits d713bc2, ba29de6 on branch `ZioHimself/snook`
- `pnpm test`, `pnpm test:integration`, `pnpm typecheck`, `pnpm lint` green at completion