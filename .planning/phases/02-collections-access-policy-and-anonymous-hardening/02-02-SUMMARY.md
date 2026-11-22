---
phase: 02-collections-access-policy-and-anonymous-hardening
plan: 02
subsystem: api
tags: [fastify, mongodb, keyset-pagination, query-parsing, indexes, tdd]
requires:
  - phase: 02-collections-access-policy-and-anonymous-hardening
    provides: registerCollections, RecordStore, requireGrant, collectionIssues, collectionsApp test helper (plan 02-01)
provides:
  - "GET /v1/{name} returning { items, nextCursor }, newest first, keyset paging on (sortField, _id)"
  - "?field=value and ?field.op=value (eq, gt, gte, lt, lte) on indexed fields and createdAt/updatedAt, typed from the schema, no coercion"
  - "?sort=[-]field over indexed fields and timestamps; limit 1..200, default 50; tamper-checked opaque cursor"
  - "indexes: [dotted.path] collection config key with seven INDEX_* startup issues"
  - "ensureIndexes and scheduleIndexSetup: compound { data.<path>: 1, _id: 1 } plus createdAt and updatedAt, created in the background with a 30 s retry"
affects: [02-04, 02-05, 02-06, 02-07, 02-08, phase-03-mirror]
requirements-completed: [COLL-03]
tech-stack:
  added: []
  patterns:
    - "query strings become JS scalars through one typing table keyed by schema type; arrays and objects never get that far"
    - "MongoDB filters are built from parsed conditions under allow-listed field names, never spread from input"
    - "errors that reach a client or a log carry a fixed code only (ListQueryError, INDEX_* issues)"
key-files:
  created:
    - src/collections/list-query.ts
    - src/collections/indexes.ts
    - test/unit/list-query.test.ts
    - test/unit/list-config.test.ts
    - test/integration/collections-list.test.ts
  modified:
    - src/config/schema.ts
    - src/collections/definition.ts
    - src/collections/store.ts
    - src/collections/routes.ts
    - src/server.ts
key-decisions:
  - "resolveIndexPath lives in definition.ts and is used by both the startup checks and the query parser, so the type the parser trusts is the type startup validated"
  - "createdAt and updatedAt filter values are normalised to toISOString form (a calendar-checked parse), not compared as the raw string: '12:00:00Z' sorts after '12:00:00.000Z', so a raw string compare would put the boundary record on the wrong side of lt"
  - "The cursor must be strict base64url JSON with exactly the members s, v, id; s equals the request's sort, v is a scalar of the sort field's type (ISO form for timestamps), id is a string"
  - "scheduleIndexSetup takes the log error as `err` and relies on the existing pino err serializer (type, code, status only); a plain { type, code } object would serialise as type Object"
patterns-established:
  - "Tests that need strictly increasing createdAt pause 3 ms between inserts"
  - "TAP failure output must be single-line to be accepted as RED evidence: compare joined strings, not arrays"
coverage:
  - id: D1
    description: "A key holder pages a collection newest first with limit and nextCursor; each record is seen once, the last page and an empty collection give nextCursor null, and a newer record between pages neither repeats nor skips one"
    requirement: "COLL-03"
    verification:
      - kind: integration
        ref: "test/integration/collections-list.test.ts#GET /v1/{name}: paging"
        status: pass
    human_judgment: false
  - id: D2
    description: "Equality and range filters on indexed fields and createdAt, with typed values; sort with _id tie-break walks 7 records with ties once, forwards and in exact reverse"
    requirement: "COLL-03"
    verification:
      - kind: unit
        ref: "test/unit/list-query.test.ts"
        status: pass
      - kind: integration
        ref: "test/integration/collections-list.test.ts#GET /v1/{name}: range filters and sort"
        status: pass
    human_judgment: false
  - id: D3
    description: "A non-indexed field, unknown operator or parameter, wrong-typed or repeated value, tampered cursor and out-of-range limit each give 400 problem+json that echoes no key, value or cursor in the body or any log line"
    requirement: "COLL-03, COLL-07"
    verification:
      - kind: unit
        ref: "test/unit/list-query.test.ts#the error"
        status: pass
      - kind: integration
        ref: "test/integration/collections-list.test.ts#GET /v1/{name}: hostile queries"
        status: pass
    human_judgment: false
  - id: D4
    description: "Startup rejects every bad indexes path in one ConfigError at /collections/<name>/indexes/<i> without echoing the path"
    requirement: "COLL-03"
    verification:
      - kind: unit
        ref: "test/unit/list-config.test.ts#indexes in collection config"
        status: pass
    human_judgment: false
  - id: D5
    description: "The five compound indexes exist after start(); index setup retries every 30 s after a failure and stops on close"
    requirement: "COLL-03"
    verification:
      - kind: integration
        ref: "test/integration/collections-list.test.ts#indexes"
        status: pass
      - kind: unit
        ref: "test/unit/list-config.test.ts#index setup scheduling"
        status: pass
    human_judgment: false
duration: ~25min
completed: 2026-11-22
status: complete
commits: 4
plan_head_before: 0eb57b9d6f8fcaeff71734c60c94a3f2155f8f64
plan_head_after: 75df61cae9dc7431bc2eeb8c31ccff0c21cae759
actuals:
  tokens: 10900
  tasks: 2
  commits: 4
---

# Phase 2 Plan 02: List, filters, sort and indexes Summary

**`GET /v1/{name}` now lists a collection newest first with keyset paging and an opaque tamper-checked cursor, filters on indexed fields and timestamps with typed eq/gt/gte/lt/lte, sorts on any indexed field with an `_id` tie-break, and the compound indexes behind it are created in the background after startup.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-11-22
- **Tasks:** 2 (each RED then GREEN)
- **Files:** 5 created, 5 modified

## Accomplishments

- Task 1: the `indexes` config key and its seven startup checks, `parseListQuery` for equality, `limit` and `cursor`, `RecordStore.list`, the route, `ensureIndexes`, and a background index scheduler wired into `start()`.
- Task 2: the five operators, the typing table, calendar-checked timestamp parsing, `sort`, and the hostile-query tests.
- Whole suite after the last commit: `pnpm test` 276 passed, `pnpm test:integration` 72 passed (the list file passed three times in a row), `pnpm typecheck` and `pnpm lint` clean.

## Task Commits

1. **Task 1** - `4828246` (test, RED) then `e871e33` (feat, GREEN)
2. **Task 2** - `ff0cd42` (test, RED) then `75df61c` (feat, GREEN)

No REFACTOR commit: the typing is already one table keyed by schema type, so there were no repeated branches to merge.

## TDD Gate Compliance

Plan type `tdd`. Both tasks have a `test(02-02)` commit before the `feat(02-02)` commit. RED evidence was run through `gsd_run check tdd-red-evidence` on a TAP report of the real run and returned `RED_EVIDENCE_OK` / `target_test_failed` each time:

| Task | Target test | Expected | Observed | Failing / passing in file |
|------|-------------|----------|----------|---------------------------|
| 1 unit | `list-config > indexes in collection config > reports every bad path ...` | INDEX_* code per bad path | no issue reported | 4 / 2 |
| 1 integration | `collections-list > paging > returns an empty list ...` | 200 `{ items: [], nextCursor: null }` | 404 | 8 / 0 |
| 2 unit | `list-query > range filters > gives one typed condition per bound` | `data.priority gte 2; data.priority lt 5` | ListQueryError (range operator unknown) | 9 / 12 |
| 2 integration | `collections-list > range filters and sort > half-open range` | priorities 2,3 | 400 | 4 / 11 |

Semantic assessment: each target ran and failed on the planned assertion for the intended reason (missing behaviour, not a load, import or fixture fault). Task 1's RED commit carries a scaffold so that is true: the `indexes` key is accepted by the config schema (otherwise `start()` fails in `beforeAll` and every test dies as a fixture fault) and `indexes.ts` exports no-op stubs (otherwise the unit file fails at import). Several Task 2 tests (unknown operator, boolean `gt`, tampered cursor, `limit` bounds) already passed in Task 1 because Task 1 rejects them; they stay as regression cover.

## Files Created/Modified

- `src/collections/list-query.ts` - `parseListQuery`, `encodeCursor`, `sortValueOf`, `ListQueryError`; cursor decode; typing table
- `src/collections/indexes.ts` - `ensureIndexes`, `scheduleIndexSetup`
- `src/collections/definition.ts` - `resolveIndexPath`, `FILTER_OPERATORS`, `indexIssues` joined to `collectionIssues`
- `src/collections/store.ts` - `RecordStore.list` (filter built from parsed conditions, `limit + 1`)
- `src/collections/routes.ts` - `GET /` with `requireGrant` for apiKey, `ListQueryError` to 400
- `src/config/schema.ts` - optional `indexes` on a collection
- `src/server.ts` - index scheduling after `listen`, stopped in `close()`
- `test/unit/list-query.test.ts`, `test/unit/list-config.test.ts`, `test/integration/collections-list.test.ts`

## Decisions Made

See `key-decisions` above. `store.list` already used `$and` and `$<op>` in Task 1 (a plain object per condition would have lost one of `status=x&status.eq=y`), so Task 2 needed no store change even though the plan lists `store.ts` under it.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Plan's raw string compare would misplace the boundary record for date-times**
- **Found during:** Task 2 design
- **Issue:** the plan says createdAt/updatedAt values "compare as strings". A value `2026-01-01T12:00:00Z` compared against stored `2026-01-01T12:00:00.000Z` sorts higher (`Z` > `.`), so `createdAt.lt=` that value would wrongly include a record created at exactly that instant. `2026-02-30` and `T24:00:00Z` are also accepted by `Date.parse`.
- **Fix:** strict regex, calendar round-trip check, then `new Date(ms).toISOString()`; the normalised string is what reaches MongoDB. Unit tests cover the normal, offset and invalid forms.
- **Files modified:** src/collections/list-query.ts, test/unit/list-query.test.ts
- **Commit:** 75df61c

**2. [Rule 1 - Bug] Test asserted the wrong route template**
- **Found during:** Task 2 RED
- **Issue:** the plan says the request log route is `/v1/ticket/`; Fastify logs the template as `/v1/ticket` for `GET /v1/ticket`.
- **Fix:** the test asserts `/v1/ticket`. The point (template, never the query string) is unchanged.
- **Files modified:** test/integration/collections-list.test.ts
- **Commit:** ff0cd42

**3. [Rule 3 - Blocking] RED evidence and the retry scheduler need their own seams**
- **Issue:** the plan names no retry seam, and a 30 s retry cannot be tested without one.
- **Fix:** `scheduleIndexSetup({ ensure, log, retryMs })` is exported and unit-tested with fake timers (added to `list-config.test.ts`, not a new file). The `err` field is the error itself, so the existing pino serializer (type, code, status) drops the message; the unit test checks the fixed message and the retry and stop behaviour, and the serializer's allow-list is covered by the Phase 1 logging canary test.
- **Files modified:** src/collections/indexes.ts, test/unit/list-config.test.ts
- **Commit:** e871e33

---

**Total deviations:** 3 auto-fixed (2 bugs, 1 blocking). **Impact on plan:** none on scope.

## Issues Encountered

- Records created in the same millisecond tie on `createdAt` and are ordered by their random UUID `_id`, so "newest first" is exact only at millisecond resolution. Paging stays stable and complete (the `_id` tie-break is the same in the cursor), but two records created in one millisecond can come back in either order. The integration tests pause 3 ms between inserts. Making ids time-ordered would change the v4 id format that plan 02-01 pins, so it is left alone.
- An outage at boot is covered by the scheduler unit test, not by an integration test that stops MongoDB.
- Two indexed paths that differ only in `.` versus `_` (`a.b` and `a_b`) would map to the same index name `idx_a_b` and make `createIndexes` fail on every retry; there is no startup check for it. The plan fixes the naming, so this is recorded rather than changed.
- The Read tool is blocked by a context-mode hook in this environment; planning files were read with `cat`.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. T-02-08 (operator injection), T-02-09 (query in logs) and T-02-10 (unindexed scans, deep pages) are mitigated as planned and covered by the hostile-query tests; no new endpoint, auth path or schema beyond `GET /v1/{name}` and the `indexes` key.

## Next Phase Readiness

Plans 02-04 to 02-08 can rely on `RecordStore.list`, `parseListQuery` and the `{ items, nextCursor }` envelope; plan 02-08's OpenAPI document can describe the list parameters from `FILTER_OPERATORS` and the `indexes` config. `.planning/` was not touched by the task commits.

---
*Phase: 02-collections-access-policy-and-anonymous-hardening*
*Completed: 2026-11-22*

## Self-Check: PASSED

All 5 created source and test files and this SUMMARY exist; commits 4828246, e871e33, ff0cd42 and 75df61c are ancestors of HEAD; `git status` shows nothing uncommitted besides this file.
