---
phase: 01-foundations-ox-spike-and-storage-layer
plan: 04
subsystem: logging
tags: [fastify5, pino, pii-free-logs, problem-json, canary, tdd]
requires:
  - phase: 01-01
    provides: "buildApp(options) factory and GET /health"
provides:
  - "loggerOptions(level, stream) allow-list serializers (req, res, err)"
  - "registerLogging(app): one request line per response, problem+json 404 and error handlers"
  - "AppOptions.logger { level?, stream? }"
  - "captureLogs() in-memory pino destination for canary tests (reused by 01-06, 01-08, 01-09)"
  - "canary test across every HTTP error path that exists in Phase 1"
affects: [01-06, 01-08, 01-09]
tech-stack:
  added: []
  patterns: [allow-list log serializers, LogController disableRequestLogging, requestIdHeader false, problem+json error envelope]
key-files:
  created: [src/http/logging.ts, test/helpers/log-capture.ts, test/unit/logging-canary.test.ts]
  modified: [src/app.ts]
key-decisions:
  - "Fastify's err serializer typing requires message and stack; the serializer is cast with `as never` because omitting them is the point"
  - "src/server.ts left unchanged: it already calls buildApp() with no logger override, so the old plain logger lived only in app.ts"
  - "4xx errors produce no error log line; only 5xx log `request failed` (type, code, kind, op, status)"
requirements-completed: [FND-03]
status: complete
duration: 5min
completed: 2026-11-21
commits: 4
plan_head_before: eefeb659a62f8a206fb43c9af10bad15c2e684cb
plan_head_after: 3f5b5113c9147fe5597285271add4e357a7c1587
actuals:
  tokens: 9000
  tasks: 2
  commits: 4
---

# Phase 1 Plan 04: PII-free logging harness Summary

**Allow-list Fastify logging (route template, generated id, status, ms) with problem+json 404/error responses, proven by a canary test over 9 HTTP paths with zero leaks.**

## Task 1: Tracer (TDD)

- **RED** `df04f1d` `test(01-04)`: `captureLogs()` helper and the unmatched-path test. Failed on the content-type assertion (`application/json` received, `application/problem+json` expected), not on an import error.
- **GREEN** `2d063c9` `feat(01-04)`: `src/http/logging.ts` and `buildApp` wiring (`logger: loggerOptions(...)`, `logController: new LogController({ disableRequestLogging: true })`, `requestIdHeader: false`, `registerLogging(app)` before routes). No FSTDEP023 warning.
- **REFACTOR**: none needed.

Tracer feedback gate: auto-advance is on, `<verify>` re-run end to end (logging-canary and health tests green), so expansion was unblocked.

## Task 2: Canary across every HTTP error path

Commits `2ea92f6` and `3f5b511` (`test(01-04)`). Cases: thrown error (500), schema-invalid body (400), truncated JSON (400), text/plain body (400), unsupported content type (415), oversize body (413), query string on a matched route (200), client `x-request-id`, plus an aggregate check (lines = requests + 5xx lines, every request line has a route template, no canary in any line or body).

**No GREEN commit: the tests passed on first run.** Task 1's allow-list already covers every path, so there was no leak to fix in `src/http/logging.ts`. To show the tests can fail, two temporary mutations were applied and reverted (not committed):
- adding `message` to the err serializer failed the thrown-error and aggregate tests;
- adding the raw `url` to the req serializer failed the unmatched-path, query-string and aggregate tests.

Verification (all pass): `pnpm test test/unit/logging-canary.test.ts test/unit/health.test.ts` 11/11, `pnpm typecheck` clean, `pnpm lint` clean (21 files). `grep -c 'disableRequestLogging: true' src/app.ts` and `grep -c 'requestIdHeader: false' src/app.ts` both print 1.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Plan expected 415 for a text/plain body; Fastify returns 400**
- **Found during:** Task 2 (first test run)
- **Issue:** Fastify ships a default `text/plain` parser, so the body reaches schema validation and fails with 400. 415 only occurs for a content type with no parser.
- **Fix:** kept a text/plain case asserting 400 and added an `application/xml` case asserting 415. Both are canary-clean. The plan's "8 paths" are all covered.
- **Files modified:** test/unit/logging-canary.test.ts
- **Commit:** 2ea92f6

**2. [Rule 3 - Blocking] Fastify logger typings reject a serializer without message and stack**
- **Found during:** Task 1 (`pnpm typecheck` after GREEN)
- **Fix:** `err: serializeError as never` with a comment. Runtime output is unchanged.
- **Files modified:** src/http/logging.ts
- **Commit:** 2d063c9

**3. [Rule 1 - Bug] Canary test did not typecheck**
- **Found during:** Task 2 (`pnpm typecheck` after the first test commit; the exit code was not checked before committing)
- **Fix:** typed the `send` helper with `InjectOptions`.
- **Commit:** 3f5b511

No architectural changes. `src/server.ts` was not modified (plan listed it; nothing to drop there).

## Auth gates

None.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. T-01-10 (allow-list serializers, default request log disabled), T-01-11 (problem+json with status text only) and T-01-12 (`requestIdHeader: false`, tested) are mitigated and covered by the canary test. T-01-SC: no packages added.

## Notes for later plans

- Phase 2 must keep headers out of the `req` serializer when API keys arrive (no pino `redact` was added, by plan).
- 01-06, 01-08 and 01-09 should extend `logging-canary.test.ts` (or reuse `captureLogs`) for config-error, adapter and readiness paths.
- Other plans (01-03, 01-11) committed to the same working tree while this plan ran, so `git rev-list` between `plan_head_before` and `plan_head_after` includes their commits. `commits: 4` counts only the `(01-04)` commits: df04f1d, 2d063c9, 2ea92f6, 3f5b511.
- Lint and typecheck were not clean repo-wide at some points mid-run because of other plans' in-progress files; they were clean at the end.

## Self-Check: PASSED

- FOUND: src/http/logging.ts, test/helpers/log-capture.ts, test/unit/logging-canary.test.ts, src/app.ts
- FOUND commits: df04f1d (test), 2d063c9 (feat), 2ea92f6 (test), 3f5b511 (test); `test(01-04)` precedes `feat(01-04)` in `git log`
