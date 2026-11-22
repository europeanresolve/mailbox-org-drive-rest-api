---
phase: 02-collections-access-policy-and-anonymous-hardening
plan: 06
subsystem: api
tags: [fastify, body-limit, content-type, honeypot, anonymous-hardening, json-schema, tdd]
requires:
  - phase: 02-collections-access-policy-and-anonymous-hardening
    provides: per-collection plugin, reject/problem() path, walker and startup checks (02-01); PUT/PATCH routes with handler-level media checks (02-04); onRequest guard and limiter order (02-05)
provides:
  - "collections.<name>.bodyLimit (bytes, 1..1048576, default 16384): route bodyLimit on POST, PUT and PATCH; Fastify answers 413 problem+json before the handler, a Content-Length over the limit is refused without reading the body, a chunked body is cut off at the limit"
  - "requireMediaType(type) onRequest hook: POST and PUT only application/json, PATCH only application/merge-patch+json; charset must be utf-8; text/plain, form encoding and a missing header get 415 problem+json before the body is read"
  - "collection.UNBOUNDED_STRING: startup rejects a collection whose create, replace or patch is anonymous when any string subschema has no maxLength (enum or const bounds it)"
  - "collections.<name>.honeypot: a filled field on anonymous create gets a fake 201 (ETag \"1\", random UUID, current createdAt); nothing stored, no extra log call; an empty or null field is deleted before validation"
  - "collection.HONEYPOT_IN_SCHEMA and collection.HONEYPOT_NOT_ANONYMOUS; honeypotFilled; anonymousCreated (one reply function for real and fake)"
affects: [02-07, 02-08, phase-03-mirror]
requirements-completed: [SEC-03, SEC-06]
tech-stack:
  added: []
  patterns:
    - "route onRequest is an array: credentials or rate limiter first, then requireMediaType, so a 401 or 429 comes before a 415"
    - "the honeypot sits inside the create handler right before validation, because record validation is not in Fastify's schema stage"
    - "a reply that must be indistinguishable is produced by one function used by both paths"
key-files:
  created:
    - test/integration/anonymous-hardening.test.ts
    - test/unit/form-config.test.ts
  modified:
    - src/config/schema.ts
    - src/config/load.ts
    - src/collections/definition.ts
    - src/collections/hardening.ts
    - src/collections/routes.ts
    - test/unit/list-config.test.ts
key-decisions:
  - "The 415 hook answers after credentials and the limiter: an unauthenticated PUT with the wrong type gets 401, not 415, so the media type is never an oracle for a caller without a key"
  - "UNBOUNDED_STRING walks every subschema including $defs and propertyNames, so a string that is never reached still has to be bounded; the stricter reading is cheaper to explain than a reachability analysis"
  - "HONEYPOT_NOT_ANONYMOUS and HONEYPOT_IN_SCHEMA both point at /collections/<name>/honeypot, the key the deployer has to change"
patterns-established:
  - "Tests that need one request's log lines take the length before, send, then vi.waitFor the onResponse line and slice"
  - "Byte-exact body fixtures are built by padding a field and asserting Buffer.byteLength equals the target"
coverage:
  - id: D1
    description: "A body of exactly bodyLimit bytes gets 201 and one byte more 413 problem+json; a multi-byte body under the limit in characters but over it in bytes gets 413; PUT and PATCH have the same limit; nothing is stored on 413"
    requirement: "SEC-03"
    verification:
      - kind: integration
        ref: "test/integration/anonymous-hardening.test.ts#body limit"
        status: pass
    human_judgment: false
  - id: D2
    description: "A declared Content-Length over the limit is answered 413 with the body never sent; a chunked body with no Content-Length is cut off at the limit"
    requirement: "SEC-03"
    verification:
      - kind: integration
        ref: "test/integration/anonymous-hardening.test.ts#body limit"
        status: pass
    human_judgment: false
  - id: D3
    description: "POST with text/plain, form encoding, charset=latin1, merge-patch type or no Content-Type gets 415 problem+json before parsing and stores nothing; charset=UTF-8 and Application/JSON get 201; PUT with merge-patch and PATCH with json get 415; credentials are checked first"
    requirement: "SEC-03"
    verification:
      - kind: integration
        ref: "test/integration/anonymous-hardening.test.ts#content type"
        status: pass
    human_judgment: false
  - id: D4
    description: "A 413 and a 415 whose bodies carry a CANARY leave no match in the response, its headers or the logs"
    requirement: "SEC-03"
    verification:
      - kind: integration
        ref: "test/integration/anonymous-hardening.test.ts#what a 413 and a 415 reveal"
        status: pass
    human_judgment: false
  - id: D5
    description: "Startup rejects unbounded strings in anonymous-write schemas at their schema pointer (nested objects, array items, anyOf, type lists), accepts enum and const strings, ignores schemas no anonymous operation writes; bodyLimit 0 and 1048577 give schema.minimum and schema.maximum, default 16384"
    requirement: "SEC-03"
    verification:
      - kind: unit
        ref: "test/unit/form-config.test.ts#strings in anonymous-write schemas"
        status: pass
      - kind: unit
        ref: "test/unit/form-config.test.ts#collections.<name>.bodyLimit"
        status: pass
    human_judgment: false
  - id: D6
    description: "A filled honeypot (text, space, 0, false, {}, []) gets 201 with ETag \"1\", body keys id and createdAt, a v4 UUID and a current timestamp; nothing is stored and GET of that id is 404; empty, null or absent gives a real create with no honeypot key stored"
    requirement: "SEC-06"
    verification:
      - kind: integration
        ref: "test/integration/anonymous-hardening.test.ts#honeypot"
        status: pass
    human_judgment: false
  - id: D7
    description: "A filled honeypot beats validation (extra property, missing required, wrong type), each fake has a fresh id, a valid API key does not bypass it, and the fake reply matches a real one in status, header names, content type and body keys"
    requirement: "SEC-06"
    verification:
      - kind: integration
        ref: "test/integration/anonymous-hardening.test.ts#honeypot"
        status: pass
    human_judgment: false
  - id: D8
    description: "The fake request writes one log line with the same keys and route as a real create's and status 201; a CANARY in the honeypot and other fields appears in no response or log line"
    requirement: "SEC-06"
    verification:
      - kind: integration
        ref: "test/integration/anonymous-hardening.test.ts#honeypot"
        status: pass
    human_judgment: false
  - id: D9
    description: "A honeypot that is also a root schema property gives collection.HONEYPOT_IN_SCHEMA, one on a collection whose create is not anonymous gives collection.HONEYPOT_NOT_ANONYMOUS, names like $x, a.b, 1abc, empty and 65 characters give schema.pattern"
    requirement: "SEC-06"
    verification:
      - kind: unit
        ref: "test/unit/form-config.test.ts#collections.<name>.honeypot"
        status: pass
    human_judgment: false
duration: ~12min
completed: 2026-11-22
status: complete
commits: 5
plan_head_before: a7028ca5d7a8964fcc383be04d9fa978378b1048
plan_head_after: c0a959b410293f7af4ce63986c223fa79267e252
actuals:
  tokens: 14000
  tasks: 2
  commits: 5
---

# Phase 2 Plan 06: Body limit, JSON-only content type and honeypot Summary

**Anonymous write routes now stop oversized bodies (413 at a per-collection byte limit, default 16 KiB), anything that is not the route's JSON type (415 before the body is read), schemas with unbounded strings (rejected at startup), and form bots (a filled hidden field gets a fake 201 that matches a real one in status, headers and body shape, stores nothing and logs only the standard request line).**

## Performance

- **Duration:** ~12 min
- **Completed:** 2026-11-22
- **Tasks:** 2 (each RED then GREEN, Task 2 with a REFACTOR)
- **Files:** 2 created, 6 modified
- Whole suite after the last commit: `pnpm test` 335 passed, `pnpm test:integration` 181 passed, `pnpm typecheck`, `pnpm lint` and `pnpm build` clean.

## Accomplishments

- Task 1: `bodyLimit` config key and route option, the `requireMediaType` onRequest hook on POST, PUT and PATCH (the 02-04 handler checks are gone), and `collection.UNBOUNDED_STRING`, reusing the 02-01 `subschemas` walker.
- Task 2: `honeypot` config key, `honeypotFilled`, the fake 201 inside the anonymous create handler before validation, the two startup checks, and a shared `anonymousCreated` reply function.

## Task Commits

1. **Task 1** - `9ccc137` (test, RED) then `1279d2f` (feat, GREEN)
2. **Task 2** - `51b2102` (test, RED), `c90b119` (feat, GREEN), `c0a959b` (refactor)

## TDD Gate Compliance

Plan type `tdd`. Both tasks have a `test(02-06)` commit before the `feat(02-06)` commit, and Task 2 a `refactor(02-06)` commit after. RED evidence came from real runs (unit: vitest, integration: `--reporter=tap-flat`) and each failed on the planned assertion, not on a load fault:

| Task | Target test | Expected | Observed | Failing / passing in file |
|------|-------------|----------|----------|---------------------------|
| 1 integration | `body limit > answers 413 problem+json for one byte more, and stores nothing` | 413 | 201 | 10 / 10 |
| 1 integration | `content type > POST with text/plain gets 415 problem+json and stores nothing` | 415 | 400 (default text parser) | same run |
| 1 unit | `strings in anonymous-write schemas > rejects a string with no maxLength` | UNBOUNDED_STRING issue | load succeeded | 4 / 7 |
| 2 integration | `honeypot > answers a filled honeypot with a fake 201 and stores nothing` | 201 | 400 (the honeypot key is an undeclared property) | 13 / 2 in the honeypot block |
| 2 unit | `honeypot > rejects a name that is also a root schema property` | HONEYPOT_IN_SCHEMA issue | load succeeded | 2 / 18 |

Both RED commits carry a config scaffold (the schema accepts `bodyLimit` with its range and default in Task 1, `honeypot` with its name pattern in Task 2) so `start()` succeeds. Tests that pass in RED only because of the scaffold or existing behaviour (a body of exactly the limit, form encoding already 415 in Fastify, a missing Content-Type already 415, `bodyLimit` range checks) stay as regression cover.

## Files Created/Modified

- `src/collections/hardening.ts` - `requireMediaType`, `honeypotFilled`
- `src/collections/routes.ts` - `bodyRoute` (onRequest array plus `bodyLimit`), honeypot branch, `anonymousCreated`; `mediaType` helper removed
- `src/collections/definition.ts` - `unboundedStrings`, `honeypotIssues`
- `src/config/schema.ts`, `src/config/load.ts` - `bodyLimit` (default 16384), `honeypot`
- `test/integration/anonymous-hardening.test.ts`, `test/unit/form-config.test.ts`
- `test/unit/list-config.test.ts` - two strings in its fixture gain `maxLength`

## Decisions Made

See `key-decisions` above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] An existing fixture broke on the new startup check**
- **Found during:** Task 1 GREEN, full unit run
- **Issue:** `test/unit/list-config.test.ts` declared `maybe` (type list with string) and `tags.items.name` without `maxLength` under an anonymous create, which `collection.UNBOUNDED_STRING` now rejects, so its "accepts a collection with no indexes key" case failed.
- **Fix:** both strings got `maxLength: 10`. No production behaviour changed; the test is about indexes.
- **Files modified:** test/unit/list-config.test.ts
- **Commit:** 1279d2f

**2. [Rule 2 - Missing critical functionality] Credentials and the rate limiter run before the media-type check**
- **Found during:** Task 1 design
- **Issue:** the plan says the hook runs "before the body is read" but not relative to auth. Putting the 415 first would tell an unauthenticated caller which media type a protected route wants, and would spend no rate-limit slot on anonymous routes.
- **Fix:** route `onRequest` is `[guard, requireMediaType]`; a test asserts an unauthenticated PUT with the wrong type gets 401.
- **Files modified:** src/collections/routes.ts, test/integration/anonymous-hardening.test.ts
- **Commit:** 1279d2f

---

**Total deviations:** 2 (1 bug, 1 missing critical functionality). **Impact on plan:** none on scope or observable results.

## Issues Encountered

- The Read tool is blocked by a context-mode hook in this environment; the plan and planning files were read with `cat` as instructed. `pnpm`, vitest and the Compose stack need the sandbox off.
- The integration check "a Content-Length over the limit is refused without reading the body" sends only the first bytes of a declared 25 600-byte body; in RED it hangs until the 30 s test timeout, which is why that one case took 30 s to fail. In GREEN it answers at once.
- Timing: the fake path skips MongoDB and is faster than a real create. The plan accepts this (edge: concurrency); the response content is the same.
- Plan 02-07 (Idempotency-Key) should add its hook after `requireMediaType` in the `bodyRoute` array, and the honeypot branch stays ahead of it in the create handler, so a bot's fake 201 never writes an idempotency entry.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. T-02-25 (oversized and padded bodies), T-02-26 (non-JSON submissions), T-02-27 (form bots) and T-02-28 (spam in logs) are mitigated as planned and covered by the byte-boundary tests, the 415 matrix, the honeypot-beats-validation test and the canary tests. T-02-SC: no packages added.

## Next Phase Readiness

Plans 02-07 and 02-08 can rely on every body route carrying `bodyLimit` and the media-type hook, `config.collections.<name>.bodyLimit` always being present, and `honeypot` being absent or a validated name. Plan 02-08's OpenAPI document should list 413 and 415 on POST, PUT and PATCH, describe `application/merge-patch+json` on PATCH, show `bodyLimit` and `honeypot` in the example config, and keep the fake 201 out of the documented responses (it is the normal 201).

## Self-Check: PASSED

Both created files and this SUMMARY exist; commits 9ccc137, 1279d2f, 51b2102, c90b119 and c0a959b are ancestors of HEAD; `git status` shows nothing uncommitted besides this file and the planning state files.
