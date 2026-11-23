---
phase: 03-mirror-worker
plan: 06
subsystem: api
tags: [nested-collections, openapi, mirror, config, tdd]
requires:
  - phase: 03-mirror-worker
    plan: 01
    provides: mirrorFolders, flat mirror tracer
provides:
  - COLLECTION_NAME_PATTERN and slash-separated collection config keys
  - collection.MIRROR_UNSAFE_PROPERTY_NAME at all schema depths
  - OpenAPI component/operationId encoding for nested names
  - Integration coverage for nested routes, grants, coexistence, mirror paths
affects: [03-03, 03-04, mirror sheet naming]
tech-stack:
  added: []
  patterns:
    - "componentBase: replaceAll('/', '_') for OpenAPI; URLs keep slashes"
    - "Grants split at last colon for nested collection names"
key-files:
  created:
    - test/integration/nested-collections.test.ts
  modified:
    - src/config/schema.ts
    - src/collections/definition.ts
    - src/http/docs.ts
    - test/unit/collection-config.test.ts
    - test/unit/docs.test.ts
key-decisions:
  - "Task 1 decision A (slash-separated names, unbounded depth) — affirmed in 03-DISCUSSION-LOG and execute dispatch"
  - "Nested path segments may start with a digit (e.g. 2026) while the first segment stays mount-style"
requirements-completed: [MIRR-01]
coverage:
  - id: nested-config
    description: Config accepts events/events/2026/signups, rejects bad names and mirror-unsafe properties
    requirement: MIRR-01
    verification:
      - kind: unit
        ref: test/unit/collection-config.test.ts
        status: pass
    human_judgment: false
  - id: nested-e2e
    description: Nested CRUD, grants, routing edge, and mirror folder layout
    requirement: MIRR-01
    verification:
      - kind: integration
        ref: test/integration/nested-collections.test.ts
        status: pass
    human_judgment: false
  - id: nested-openapi
    description: OpenAPI paths with slashes; component keys with underscores
    verification:
      - kind: unit
        ref: test/unit/docs.test.ts#nested collection OpenAPI names
        status: pass
    human_judgment: false
actuals:
  tokens: 52000
  tasks: 3
  commits: 5
plan_head_before: e956bb0aa7e2fa9bc72ad73d53e4553317c40bbe
plan_head_after: f4233d9b0c2ddfa7d375f6cbb0b9aca821eade41
duration: 5min
completed: 2026-11-23
status: complete
---

# Phase 3 Plan 6: Nested Collection Names Summary

**Slash-separated collection names across config, grants, OpenAPI, routes, and mirror paths, with mirror-unsafe property rejection and end-to-end integration coverage.**

## Performance

- **Duration:** ~5 min
- **Tasks:** 3/3 (Task 1 decision recorded; Tasks 2–3 TDD)
- **Commits (03-06):** 5 on branch `ZioHimself/snook`

## Task 1 — Decision

**Option A:** Config keys like `events/2026/signups`, routes `/v1/events/2026/signups`, grants `events/2026/signups:<op>`, mirror `<mount>/events/2026/signups.xlsx`, MongoDB `records_events/2026/signups`, OpenAPI `events_2026_signups.*`. Matches 03-DISCUSSION-LOG (slash-separated, no depth cap, shared prefixes allowed).

## TDD Gate Compliance

| Step | Task | Commit | Evidence |
|------|------|--------|----------|
| RED | 2 | `c27dcda` test(03-06): add nested collection config cases | `pnpm test … -t "nested collection names"` failed (nested load + MIRROR_UNSAFE) |
| GREEN | 2 | `aa1e470` feat(03-06): slash-segment collection names… | 22/22 nested unit tests pass |
| RED | 3 | `2202b22` test(03-06): nested routes OpenAPI… | docs nested components missing `_` encoding |
| GREEN | 3 | `1fab568` feat(03-06): encode nested names in OpenAPI… | integration + docs tests pass |
| — | — | `f4233d9` chore(03-06): biome fixes | lint/typecheck green |

## Accomplishments

- `COLLECTION_NAME_PATTERN` on the collections record; semantic checks use first-segment reserved names and `lastIndexOf(':')` grant parsing.
- `collection.MIRROR_UNSAFE_PROPERTY_NAME` for `: \ / ? * [ ] ( ) '` in property names (walk at every depth).
- `componentBase` in `docs.ts`: slashes only in paths/summaries; schemas and `operationId` use `_`.
- `test/integration/nested-collections.test.ts`: coexistence of `events` and `events/2026/signups`, GET `/v1/events/2026` → 404 problem+json, grant isolation, mirror folders and `signups` sheet.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Critical] Nested segments allow leading digits**

- **Found during:** Task 2
- **Issue:** Plan examples use `events/2026/...` but strict per-segment `MOUNT_NAME_PATTERN` rejects `2026`.
- **Fix:** `COLLECTION_NAME_PATTERN` uses `(/[a-z0-9][a-z0-9-]{0,31})*` after the first segment.
- **Files:** `src/config/schema.ts`
- **Commit:** `aa1e470`

**2. [Rule 1 - Bug] Integration mirror row assertion timing**

- **Found during:** Task 3
- **Issue:** DELETE ran before mirror assertion; workbook no longer contained the row.
- **Fix:** Assert mirror contents after PATCH, before DELETE.
- **Files:** `test/integration/nested-collections.test.ts`
- **Commit:** `1fab568`

## Verification

- `pnpm test test/unit/collection-config.test.ts` — pass
- `pnpm test test/unit/docs.test.ts` — pass
- `pnpm typecheck` — pass
- `pnpm lint` — pass
- `pnpm stack:up && pnpm test:integration test/integration/nested-collections.test.ts` — pass
- `pnpm test:integration` (full) — 223 passed

## Self-Check

```
FOUND: src/config/schema.ts (COLLECTION_NAME_PATTERN)
FOUND: src/collections/definition.ts (MIRROR_UNSAFE_PROPERTY_NAME)
FOUND: src/http/docs.ts (replaceAll("/", "_"))
FOUND: test/integration/nested-collections.test.ts
FOUND: c27dcda
FOUND: aa1e470
FOUND: 2202b22
FOUND: 1fab568
FOUND: f4233d9
```

## Self-Check: PASSED