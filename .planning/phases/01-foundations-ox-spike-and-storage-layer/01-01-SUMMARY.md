---
phase: 01-foundations-ox-spike-and-storage-layer
plan: 01
subsystem: infra
tags: [typescript7, fastify5, pnpm12, vitest, biome, docker, tdd, walking-skeleton]
requires: []
provides:
  - "pnpm 12 ESM project with exact pins for all Phase 1 packages"
  - "buildApp(options) Fastify factory with GET /health"
  - "start() composition root with SIGTERM/SIGINT graceful close"
  - "two-stage node:26-slim image (mailbox-org-drive-rest-api:dev) running as uid 1000"
  - "vitest unit project (pnpm test, no Docker), biome ci lint, tsc typecheck"
affects: [01-02, 01-03, 01-04, 01-09, 01-11]
tech-stack:
  added: [fastify@5.12.8, pino@10.4.0, typebox@1.4.7, ajv@8.20.0, yaml@2.9.1, mongodb@7.9.1, webdav@5.11.0, p-retry@9.0.0, p-limit@7.3.3, typescript@7.0.2, vitest@5.1.1, "@biomejs/biome@2.6.8", "@types/node@26.6.6", pnpm@12.21.0]
  patterns: [buildApp/start split, relative imports with .ts extensions, erasableSyntaxOnly, dist-only production image]
key-files:
  created: [package.json, pnpm-lock.yaml, tsconfig.json, tsconfig.build.json, biome.json, vitest.config.ts, src/app.ts, src/server.ts, test/unit/health.test.ts, Dockerfile, .dockerignore]
  modified: []
key-decisions:
  - "Biome ignores **/*.md: biome 2.6.8 formats embedded code in markdown and failed on pre-existing README.md and PROJECT-BRIEF.md"
  - "Plain Fastify logger { level: info } for now; plan 01-04 replaces it with the PII-free harness"
requirements-completed: [DEV-02]
status: complete
duration: 10min
completed: 2026-11-21
commits: 2
plan_head_before: 11de3110edde93775229f0d2229510604c9fd46a
plan_head_after: 3d46e9b831601d15e32108a870d888322ccb3ebe
actuals:
  tokens: 16800
  tasks: 2
  commits: 2
---

# Phase 1 Plan 01: Walking skeleton part 1 Summary

**Fastify 5 / TypeScript 7 / pnpm 12 scaffold serving `GET /health` from the unit test, from `node dist/server.js` and from a non-root container image.**

## Task 1: Package legitimacy checkpoint (record only)

The user approved all eight flagged packages before any install, with no re-prompt. Registry data was fetched with `npm view` at execution time (`node_modules/` did not exist beforehand).

| Package | Version | Published (UTC) | Repository | Install-time scripts |
|---------|---------|-----------------|------------|----------------------|
| fastify | 5.12.8 | 2026-11-02T10:46:39Z | github.com/fastify/fastify | none |
| typebox | 1.4.7 | 2026-11-12T16:30:12Z | github.com/sinclairzx81/typebox | none |
| mongodb | 7.9.1 | 2026-11-19T16:47:03Z | github.com/mongodb/node-mongodb-native | none (`prepare` is a dev-time lifecycle only) |
| p-retry | 9.0.0 | 2026-11-02T20:39:55Z | github.com/sindresorhus/p-retry | none |
| vitest | 5.1.1 | 2026-11-18T07:35:25Z | github.com/vitest-dev/vitest | none |
| @biomejs/biome | 2.6.8 | 2026-11-15T14:34:16Z | github.com/biomejs/biome | none |
| @types/node | 26.6.6 | 2026-10-28T18:36:36Z | github.com/DefinitelyTyped/DefinitelyTyped | none |
| pnpm | 12.21.0 | 2026-11-13T21:01:11Z | github.com/pnpm/pnpm | `preinstall` and `postinstall`: `node install.js` (installs the pnpm binary; installed globally with the user's approval) |

Note for the record: pnpm itself is the only approved package with install scripts. It was installed globally via `npm install -g pnpm@12.21.0`. No project dependency has build scripts.

## Task 2: Tracer (TDD)

- **RED** `d0f604b` `test(01-01)`: `buildApp()` returned a bare Fastify with no routes. `pnpm test` failed on the status assertion: `AssertionError: expected 404 to be 200` (not an import error).
- **GREEN** `3d46e9b` `feat(01-01)`: registered `GET /health` returning `{status:"ok"}`, added `start()`, Dockerfile and `.dockerignore`.
- **REFACTOR**: none needed.

Verification (all pass):
- `pnpm test` 1/1 passed, `pnpm typecheck` and `pnpm lint` clean.
- `pnpm build` emits `dist/server.js`.
- `docker build -t mailbox-org-drive-rest-api:dev .` succeeded; the container answered `GET /health` with `{"status":"ok"}` (the first curl attempt hit the starting container and was retried by the loop); `docker run --entrypoint id ... -u` printed `1000`.
- `.dockerignore` holds all six required patterns, one per line.
- `grep -cE '"[\^~]' package.json` prints 0; `packageManager` is `pnpm@12.21.0`.
- Biome `noFloatingPromises` verified to flag an unawaited promise as an error (scratch file, removed).
- pnpm supply-chain policies passed on install (exact pins of fresh versions were accepted; minimum release age setting not changed).

Tracer feedback gate: auto-advance is on and `<verify>` passed end to end, so expansion is unblocked. The task is `type=tracer` without `gate="blocking-human"`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Biome failed on pre-existing markdown docs**
- **Found during:** Task 2 (`pnpm lint` after GREEN scaffold)
- **Issue:** `biome ci .` reported formatting errors in the existing `README.md` and `PROJECT-BRIEF.md` (embedded YAML in markdown), so `pnpm lint` could not be green without rewriting user docs.
- **Fix:** added `"!**/*.md"` to `files.includes` in `biome.json`. Docs are not reformatted. (An initial `biome format --write .` touched both files; they were reverted with `git checkout` before commit, so neither is in any commit.)
- **Files modified:** biome.json
- **Commit:** 3d46e9b

**2. [Rule 3 - Blocking] `pnpm` was not installed locally**
- Installed globally with `npm install -g pnpm@12.21.0` as the plan prescribes; recorded here because it is an environment change outside the repo.

No architectural changes.

## Auth gates

None.

## Known Stubs

None. `AppOptions` is an intentionally empty interface (documented in code, extended by plans 01-04 and 01-09).

## Threat Flags

None beyond the plan's threat model. T-01-01 (build-context exclusions), T-01-03 (`USER node`, uid 1000) and T-01-SC (legitimacy gate, exact pins, committed lockfile, `--frozen-lockfile`) are mitigated as planned.

## Notes for later plans

- `package.json` has no `test:integration` or `stack:*` scripts yet (plan 01-11).
- Uncommitted `.planning/STATE.md` and `.planning/state.json` changes existed before this plan began (execution-start bookkeeping).

## Self-Check: PASSED

- FOUND: package.json, pnpm-lock.yaml, tsconfig.json, tsconfig.build.json, biome.json, vitest.config.ts, src/app.ts, src/server.ts, test/unit/health.test.ts, Dockerfile, .dockerignore
- FOUND commits: d0f604b (test), 3d46e9b (feat); `test(01-01)` precedes `feat(01-01)` in `git log`
