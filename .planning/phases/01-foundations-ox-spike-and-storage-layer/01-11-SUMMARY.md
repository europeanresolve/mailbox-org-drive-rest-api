---
phase: 01-foundations-ox-spike-and-storage-layer
plan: 11
subsystem: testing
tags: [docker-compose, mongodb, webdav, vitest, integration, loopback-guard, tdd, walking-skeleton]
requires:
  - phase: 01-01
    provides: "vitest unit project, pnpm scripts, pinned mongodb dependency"
provides:
  - "docker-compose.yml: mongo:8.0 and hacdias/webdav:v5 bound to 127.0.0.1 only"
  - "dev/webdav.yml: dev-only config with one synthetic user"
  - "vitest integration project with globalSetup (STACK, assertLoopback, polling, runId, teardown)"
  - "scripts test:integration, stack:up, stack:down"
affects: [01-05, 01-08, 01-09, 01-12]
tech-stack:
  added: []
  patterns: [per-run UUID database and WebDAV folder, globalSetup provide/inject of runId, loopback guard before any request, PROPFIND readiness polling]
key-files:
  created: [docker-compose.yml, dev/webdav.yml, test/integration/global-setup.ts, test/integration/stack.test.ts, test/unit/stack-guard.test.ts]
  modified: [vitest.config.ts, package.json]
key-decisions:
  - "Integration helpers use plain fetch with Basic auth for WebDAV; the webdav package is not needed for the smoke cases"
  - "assertLoopback never echoes the offending URL in its error (a URL can carry credentials)"
requirements-completed: [DEV-01, DEV-02]
status: complete
duration: 6min
completed: 2026-11-21
commits: 4
plan_head_before: 2d063c95ee4e18662c22aa3b267323ec14d4d3ac
plan_head_after: bcc093ba77cf5a7a840f748bd664524518c6769b
actuals:
  tokens: 9000
  tasks: 2
  commits: 4
---

# Phase 1 Plan 11: Docker integration stack Summary

**One-command Compose stack (mongo:8.0 + hacdias/webdav:v5 on loopback) with a vitest integration project that does a real MongoDB and a real WebDAV round trip and refuses any non-loopback target.**

## Task 1: Local stack and integration project (tracer, TDD)

- **RED** `fee9137` `test(01-11)`: added the integration project, `global-setup.ts`, `stack.test.ts` and the three scripts with no Compose files. `pnpm test:integration` failed in setup: `integration stack did not become ready within 10 s` (nothing on 27017/6065), not an import or syntax error.
- **GREEN** `d09664a` `feat(01-11)`: added `docker-compose.yml` and `dev/webdav.yml`. `pnpm stack:up && pnpm test:integration` gives 1 file, 2 tests passed.
- **REFACTOR**: none needed.

## Task 2: Stack-down message and loopback guard (TDD)

- **RED** `d794def` `test(01-11)`: `stack-guard.test.ts` against a never-throwing `assertLoopback` stub: 2 failed (both refusals), 1 passed. The stack-down run against the Task 1 setup timed out without naming services.
- **GREEN** `bcc093b` `feat(01-11)`: `assertLoopback` parses each URL with `new URL` and accepts only 127.0.0.1, localhost and `[::1]`. `setup` calls it before any request. The 10 s poll timeout now throws `integration stack not reachable after 10 s: MongoDB and WebDAV unreachable. Run pnpm stack:up and retry.`
- **REFACTOR**: none needed.

## Verification

- `pnpm stack:up && pnpm test:integration`: 2 passed (re-run after the stack-down check, also green).
- Stack-down check (the plan's exact sequence): run exits non-zero and the output contains `pnpm stack:up`.
- `pnpm test test/unit/stack-guard.test.ts`: 3 passed.
- `docker compose config --services` prints `mongo` and `webdav`; `grep -c '127.0.0.1:' docker-compose.yml` prints 2; `grep -cE '^\s*it\(' test/integration/stack.test.ts` prints 2.
- After a green run, PROPFIND `Depth: 1` on the WebDAV root shows 0 `run-` entries (teardown works).
- `biome ci` is clean on every file this plan touched. `pnpm test` (unit project) does not touch Docker.

Tracer feedback gate: auto-advance is on, no `gate="blocking-human"`, and `<verify>` passed end to end, so expansion was unblocked.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Docker needed access outside the command sandbox**
- **Found during:** Task 1 GREEN
- **Issue:** `docker` could not reach its socket (`permission denied ... docker.sock`) inside the sandbox, and image pulls need network.
- **Fix:** ran the docker, `stack:*` and integration commands with sandbox access lifted. No repo change.

No architectural changes.

## Auth gates

None.

## Known Stubs

None. The `assertLoopback` stub existed only in the RED commit `d794def`.

## Threat Flags

None beyond the plan's threat model. T-01-02 (loopback-only ports, synthetic credentials) and T-01-33 (`assertLoopback` before any request, unit-tested with refused hosts) are mitigated as planned.

## Notes for later plans

- This plan ran in a tree shared with plans 01-03 and 01-04, so `git rev-list plan_head_before..HEAD` also counts their commits. `commits: 4` counts only the four `(01-11)` commits (`fee9137`, `d09664a`, `d794def`, `bcc093b`).
- One `biome format --write test` run covered the whole `test/` directory, so it may have applied formatting-only changes to 01-04's in-progress `test/unit/logging-canary.test.ts`. No 01-11 commit contains that file; 01-04 committed it afterwards.
- `pnpm typecheck` had errors in `src/app.ts` (Fastify HTTP/2 typing) from 01-04's in-progress work; none in 01-11 files. `test/unit/mounts.test.ts` was failing as 01-03's RED state.
- The stack is left running (`pnpm stack:down` to stop it). Ports 27017 and 6065 are fixed; a clash makes `stack:up` fail (flagged assumption, unresolved).

## Self-Check: PASSED

- FOUND: docker-compose.yml, dev/webdav.yml, test/integration/global-setup.ts, test/integration/stack.test.ts, test/unit/stack-guard.test.ts, vitest.config.ts, package.json
- FOUND commits: fee9137, d09664a, d794def, bcc093b; `test(01-11)` precedes `feat(01-11)` for both tasks in `git log`
