---
phase: 03-mirror-worker
plan: 07
subsystem: api
tags: [mirror, operator-api, api-keys, tdd, force-upload]
requires:
  - phase: 03-mirror-worker
    plan: 03
    provides: mirror worker pass and mirror_state
  - phase: 03-mirror-worker
    plan: 05
    provides: reconcileRequested scheduling
  - phase: 03-mirror-worker
    plan: 06
    provides: nested collection names in config order
provides:
  - GET /mirror/status and POST /mirror with mirror:status and mirror:rebuild grants
  - OPERATOR_GRANTS in collection config validation
  - forceUpload bypass for D-04 hash skip on operator rebuild
affects: [03-08, deployer apiKeys config]
tech-stack:
  added: []
  patterns:
    - "Operator routes registered on api, worker, and all roles when mirror is configured"
    - "Shared ConfigKeyStore from server.ts for collection and mirror routes"
key-files:
  created:
    - src/mirror/routes.ts
    - test/integration/mirror-operator.test.ts
  modified:
    - src/collections/definition.ts
    - src/mirror/state.ts
    - src/mirror/worker.ts
    - src/app.ts
    - src/server.ts
    - test/unit/collection-config.test.ts
key-decisions:
  - "Task 1 option A — GET/POST /mirror with mirror:status and mirror:rebuild on every role (api, worker, all); recorded per discussion and plan discretion"
patterns-established:
  - "Operator grants validated via OPERATOR_GRANTS map separate from collection grants"
requirements-completed: [MIRR-08]
coverage:
  - id: operator-grants-config
    description: Config accepts mirror:status/rebuild and rejects other mirror grants
    requirement: MIRR-08
    verification:
      - kind: unit
        ref: test/unit/collection-config.test.ts#operator mirror grants (03-07)
        status: pass
    human_judgment: false
  - id: operator-routes-e2e
    description: Status read model, rebuild, auth, and value-free responses
    requirement: MIRR-08
    verification:
      - kind: integration
        ref: test/integration/mirror-operator.test.ts
        status: pass
    human_judgment: false
actuals:
  tokens: 11500
  tasks: 3
  commits: 4
plan_head_before: 025db1606e315cd9f6c8722ea4c76dee6d0f702b
plan_head_after: 4272243f0e06ec085330259233c4ab6d0c0dfc8e
duration: 5min
completed: 2026-11-23
status: complete
---

# Phase 03 Plan 07: Mirror operator API Summary

**Operator mirror status and forced rebuild behind `mirror:status` / `mirror:rebuild` grants on unversioned routes.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-11-23T05:57:22Z
- **Completed:** 2026-11-23T06:01:30Z
- **Tasks:** 3 completed (Task 1 decision A applied per plan discretion)
- **Files modified:** 8

## Accomplishments

- Added `OPERATOR_GRANTS` so deployers can grant only `mirror:status` and `mirror:rebuild`.
- Implemented `GET /mirror/status` (value-free read model, `Cache-Control: no-store`) and `POST /mirror` (202 accepted, optional `collection` query).
- Worker honors `forceUpload` to bypass content-hash skip; `requestRebuild` clears backoff via `nextAttemptAt` unset.
- Wired routes on all roles when `mirror` is configured, sharing one `ConfigKeyStore`.

## Task Commits

1. **Task 2 RED:** operator grant unit tests — `73f2391` (test)
2. **Task 2 GREEN:** `OPERATOR_GRANTS` — `7479620` (feat)
3. **Task 3 RED:** mirror-operator integration — `21618ad` (test)
4. **Task 3 GREEN:** routes, state, worker, app, server — `4272243` (feat)

**Plan metadata:** pending (docs commit)

## Decisions Made

- **D-22 operator exposure (option A):** `GET /mirror/status` and `POST /mirror` with grants `mirror:status` / `mirror:rebuild`, registered in `api`, `worker`, and `all` roles (operational routes like health/ready).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Test] Rebuild wait did not wait for worker pass**
- **Found during:** Task 3 verification
- **Issue:** `waitMirrored` returned immediately after POST `/mirror` because `dirtySeq` was already settled.
- **Fix:** Wait for `forceUpload` to clear and a new `mirror written` log line before asserting ETag change.
- **Files modified:** `test/integration/mirror-operator.test.ts`
- **Commit:** `21618ad`

None otherwise — plan executed as written.

## Verification

- `pnpm test` (unit): pass (453 tests)
- `pnpm typecheck`: pass
- `pnpm lint`: pass
- `pnpm test:integration test/integration/mirror-operator.test.ts`: pass
- Full `pnpm test:integration`: intermittent failures under parallel load in unrelated tests (WebDAV folder isolation); re-runs of failing files pass in isolation

## Self-Check

- [x] `src/mirror/routes.ts` exists
- [x] `test/integration/mirror-operator.test.ts` exists
- [x] Commits `73f2391`, `7479620`, `21618ad`, `4272243` on HEAD ancestry

## Self-Check: PASSED