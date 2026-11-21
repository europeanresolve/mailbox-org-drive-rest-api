---
phase: 01-foundations-ox-spike-and-storage-layer
plan: 09
subsystem: http
tags: [readiness, mongodb, drive-health, single-flight, composition-root, canary, tdd]
requires:
  - phase: 01-06
    provides: "loadConfig, ConfigError, start() skeleton and its startup test"
  - phase: 01-08
    provides: "WebDavAdapter with retry, cooldown and path-free StorageError"
provides:
  - "createMongo(uri): lazy MongoClient (1500 ms server selection) with ping() as the only Phase 1 command, plus close()"
  - "registerHealthRoutes(app, checks?), ReadinessChecks, DriveState: /health liveness and /ready (200 or 503, enumerated states only)"
  - "createDriveHealth({ probe, ttlMs, now, log }): cached, single-flight, never-awaiting Drive state"
  - "start(options) returns { app, close }, wired to Mongo, WebDavAdapter, mounts and DriveHealth"
  - "End-to-end canary sweep over the Mongo and Drive failure paths"
affects: [01-10, 01-12, 02, 03, 04]
actuals:
  tokens: 5600
  tasks: 3
  commits: 6
tech-stack:
  added: []
  patterns: [state() returns the cache and starts one background probe, the in-flight promise is the single-flight marker, driveState closure so the app is built before DriveHealth exists, adapterTimings as a test-only start option]
key-files:
  created:
    - src/db/mongo.ts
    - src/http/health.ts
    - src/storage/drive-health.ts
    - test/integration/ready.test.ts
    - test/integration/canary.test.ts
    - test/unit/drive-health.test.ts
  modified:
    - src/app.ts
    - src/server.ts
    - test/unit/health.test.ts
    - test/unit/config.test.ts
key-decisions:
  - "Every DriveHealth state change is logged at warn, including the first move from unknown to up, as the plan specifies one warn line per change"
  - "SIGTERM and SIGINT handlers live in the main guard, not in start(), so repeated start() calls (tests) leave no listeners behind"
  - "A failed startup closes the Mongo client before rethrowing, so a listen error does not leave a client open"
requirements-completed: [FND-02, FND-03]
status: complete
duration: 5min
completed: 2026-11-21
commits: 6
plan_head_before: c02b7d74ca26dcf8afd3eb236c53ec1fa79073a7
plan_head_after: e5d5bc53550477ad01387c4d194e1e76e39fca33
---

# Phase 1 Plan 09: Readiness, Drive health and canary sweep Summary

**`/ready` fails only on a real MongoDB ping and reports the Drive state from a 30 s cached, single-flight probe that never blocks the request; `start()` now composes config, Mongo, adapter and mounts into `{ app, close }`; and an end-to-end canary sweep shows no Mongo URI password, WebDAV password, mount path or query string reaches a log line on any failure path.**

## Tasks

| Task | Type | RED | GREEN |
|------|------|-----|-------|
| 1. /ready answers from a real MongoDB ping | tracer, tdd | `79c782a` test | `53039d9` feat |
| 2. Drive state from a cached, single-flight, non-blocking probe | auto, tdd | `4ce0dd5` test | `a0eda91` feat |
| 3. Composition root wiring and the end-to-end canary sweep | auto, tdd | `44051dc` test | `e5d5bc5` feat |

No REFACTOR commit was needed.

## TDD evidence (RED runs)

- **Task 1:** 2 of 2 failing on `expected 404 to be 200` and `expected 404 to be 503` (no `/ready` route). `createMongo` did not exist yet, so the RED test used a local `MongoClient` stand-in with the same options; an import error would have been INVALID_RED. The GREEN commit swapped the stand-in for `createMongo`.
- **Task 2:** 12 of 18 failing on assertions against a skeleton `createDriveHealth` whose `state()` stays `unknown` (probe counts 0 instead of 1, state `unknown` instead of `up`, no log line). The 6 `/ready` and `/health` fake-check tests in `health.test.ts` already passed on the Task 1 route, as the plan expected.
- **Task 3:** 5 of 5 failing on `expected 404 to be 200/503` against a `start()` skeleton that returns `{ app, close }` and accepts `adapterTimings` but wires no checks. The skeleton also moved the 01-06 startup test to the new call shape, which stayed green.
- **Tracer gate (Task 1):** after GREEN the integration test, the two named unit files and `pnpm typecheck` were re-run and passed before Task 2 began.

## Verification

- `pnpm test`: 10 files, 212 tests passed
- `pnpm test:integration` (Compose stack up): 4 files, 43 tests passed
- `pnpm typecheck` and `pnpm lint`: clean
- `grep -c serverSelectionTimeoutMS src/db/mongo.ts` prints 1; `grep -c 'createDriveHealth(' src/server.ts` prints 1
- The 503 case in `ready.test.ts` asserts under 3000 ms; it measures about 1.5 s

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Close the Mongo client when startup fails**
- **Found during:** Task 3
- **Issue:** `start()` creates the `MongoClient` before `app.listen`. A listen error (port in use) would leave the client open.
- **Fix:** the setup runs in a try block whose catch closes the client and rethrows.
- **Files modified:** `src/server.ts`
- **Commit:** `e5d5bc5`

**2. [Rule 3 - Blocking] RED needed a stand-in or skeleton to fail on an assertion**
- **Found during:** Tasks 1, 2 and 3
- **Issue:** the planned RED tests import modules that do not exist, which fails at import and is INVALID_RED per `tdd.md`.
- **Fix:** Task 1 used a `MongoClient` stand-in in the test; Tasks 2 and 3 committed typechecking skeletons (`createDriveHealth` stuck at `unknown`; `start()` returning `{ app, close }` with no wiring), the same pattern as plan 01-08.
- **Files modified:** `test/integration/ready.test.ts`, `src/storage/drive-health.ts`, `src/server.ts`
- **Commits:** `79c782a`, `4ce0dd5`, `44051dc`

The plan said to move the SIGTERM and SIGINT handlers to the main guard; that is recorded under key decisions, not as a deviation.

## Auth gates

None.

## Flagged assumptions (carried from the plan)

- FND-02: a Mongo ping that is slow but finishes inside `serverSelectionTimeoutMS` counts as up. There is no hysteresis, so `/ready` can flap if MongoDB flaps. Orchestrator probe thresholds are assumed to absorb this. Not resolved here.
- T-01-28 accepted: the `/ready` body shows Drive state to anyone who can reach the port. Restrict it at the gateway later.

## Known Stubs

None. The `createDriveHealth` skeleton from the RED commit was replaced in `a0eda91`.

## Threat Flags

None. The only new network surface is `/ready`, which the plan's threat model covers (T-01-28, T-01-29, T-01-30).

## Self-Check: PASSED

- FOUND: `src/db/mongo.ts`, `src/http/health.ts`, `src/storage/drive-health.ts`, `test/integration/ready.test.ts`, `test/integration/canary.test.ts`, `test/unit/drive-health.test.ts`
- FOUND commits: `79c782a`, `53039d9`, `4ce0dd5`, `a0eda91`, `44051dc`, `e5d5bc5`
