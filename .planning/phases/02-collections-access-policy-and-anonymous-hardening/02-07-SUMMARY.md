---
phase: 02-collections-access-policy-and-anonymous-hardening
plan: 07
subsystem: api
tags: [idempotency, mongodb, ttl-index, fastify, exactly-once, tdd]
requires:
  - phase: 02-collections-access-policy-and-anonymous-hardening
    provides: create handler, RecordStore, ensureIndexes (02-01); DELETE route (02-04); requireMediaType hook and honeypot branch ahead of validation (02-06)
provides:
  - "Idempotency-Key on create (SEC-08, D-09): a retry with the same key and body returns the original status, ETag and body and stores no second record; same key with another body or principal gets 422 problem+json; a duplicate while the first is in flight gets 409 problem+json"
  - "IdempotencyStore over the _idempotency collection: begin, complete, abandon, removeForRecord; entry _id is sha256(collection + newline + key), the raw key is never stored or logged"
  - "Exactly-once across crashes: the record id is chosen with the pending entry; a request taking over a lock older than 30 s (atomic findOneAndUpdate on lockedAt) stores under that id, and a duplicate-id error means the record exists and is read back"
  - "24 h TTL index on createdAt and an index on recordId; begin also treats an entry older than 24 h as absent"
  - "DELETE removes the idempotency entry of the deleted record (D-13 with D-09; the 02-04 flag)"
  - "parseIdempotencyKey (1..255 visible ASCII), canonicalHash (SHA-256 over key-sorted JSON), entryId, principalOf(request), RecordStore.insert(name, data, id?)"
affects: [02-08, phase-03-mirror]
requirements-completed: [SEC-08]
tech-stack:
  added: []
  patterns:
    - "pessimistic pending entry: the unique _id of the entry decides which concurrent request stores"
    - "one function builds and one function sends every create reply (real, replayed, honeypot fake)"
    - "principal of an apiKey request is recorded by requireGrant in a WeakMap and read with principalOf"
key-files:
  created:
    - src/collections/idempotency.ts
    - test/unit/idempotency.test.ts
    - test/integration/idempotency.test.ts
  modified:
    - src/collections/routes.ts
    - src/collections/store.ts
    - src/collections/indexes.ts
    - src/auth/api-keys.ts
key-decisions:
  - "Hook order in the create handler is honeypot, then validation, then key parsing and begin(); the key is only read after validation, so a bot's fake 201, a 400 and every earlier refusal (401, 403, 413, 415, 429) write no entry and the key stays reusable"
  - "The Idempotency-Key is not an onRequest hook: begin() needs the validated body for its hash, so it sits in the handler after requireMediaType and the honeypot, as 02-06 advised"
  - "An invalid key answers 400 with keyword idempotencyKey only; the value is never echoed"
  - "A takeover only succeeds for the same principal and body hash; a different principal or body gets 422 even when the lock is stale"
patterns-established:
  - "Entries are seeded directly into _idempotency in tests (seedPending) to build crash and expiry states without sleeping"
coverage:
  - id: D1
    description: "Same key and body replays the original 201, ETag and body (byte-identical, also after a PUT changed the record); keys in another order are the same body; one record stored"
    requirement: "SEC-08"
    verification:
      - kind: integration
        ref: "test/integration/idempotency.test.ts#replay"
        status: pass
    human_judgment: false
  - id: D2
    description: "Same key with another body 422, another API key 422 without the first key's record; key scope is per collection; header ignored on non-create operations; no header behaves as before"
    requirement: "SEC-08"
    verification:
      - kind: integration
        ref: "test/integration/idempotency.test.ts#replay"
        status: pass
    human_judgment: false
  - id: D3
    description: "Five parallel creates with one key store one record (201 with one id, or 409); a pending lock under 30 s gives 409; an older lock is taken over under the entry's record id; a record already stored under that id is returned, not duplicated; an entry over 24 h old is treated as absent"
    requirement: "SEC-08"
    verification:
      - kind: integration
        ref: "test/integration/idempotency.test.ts#concurrency and recovery"
        status: pass
    human_judgment: false
  - id: D4
    description: "A 400, a filled honeypot, a 401 and a 415 write no entry; invalid keys (empty, 256 chars, space, non-ASCII) get 400 problem+json, 255 characters are accepted"
    requirement: "SEC-08"
    verification:
      - kind: integration
        ref: "test/integration/idempotency.test.ts#what writes no entry"
        status: pass
      - kind: integration
        ref: "test/integration/idempotency.test.ts#key format"
        status: pass
    human_judgment: false
  - id: D5
    description: "DELETE removes the entry of the deleted record and a retry of that create makes a new record; _idempotency has a 24 h TTL index on createdAt, an index on recordId, and createdAt is a BSON Date"
    requirement: "SEC-08"
    verification:
      - kind: integration
        ref: "test/integration/idempotency.test.ts#hard delete"
        status: pass
      - kind: integration
        ref: "test/integration/idempotency.test.ts#indexes"
        status: pass
    human_judgment: false
  - id: D6
    description: "A CANARY used as Idempotency-Key and in a body appears in no 409 or 422 response, header, log line or stored _idempotency document"
    requirement: "SEC-08"
    verification:
      - kind: integration
        ref: "test/integration/idempotency.test.ts#what a key and its refusals reveal"
        status: pass
    human_judgment: false
  - id: D7
    description: "canonicalHash ignores key order at every depth, keeps array order, separates 1 from \"1\"; entryId hides the key and resists boundary shifting; parseIdempotencyKey accepts 1..255 visible ASCII and rejects the rest"
    requirement: "SEC-08"
    verification:
      - kind: unit
        ref: "test/unit/idempotency.test.ts"
        status: pass
    human_judgment: false
duration: ~10min
completed: 2026-11-22
status: complete
commits: 3
plan_head_before: 2ce88245a8e98645cd1ae39a250c3821398bef3e
plan_head_after: 2b7a7311a481b9246f8c78d4fb498297153a5f4c
actuals:
  tokens: 9000
  tasks: 1
  commits: 3
---

# Phase 2 Plan 07: Idempotency-Key on create Summary

**A form submission that is retried with the same `Idempotency-Key` is stored exactly once and gets the original answer back; a key reused with another body or by another API key gets 422, a duplicate in flight gets 409, and deleting a record deletes its idempotency entry.**

## Performance

- **Duration:** ~10 min
- **Completed:** 2026-11-22
- **Tasks:** 1 (RED, GREEN, REFACTOR)
- **Files:** 3 created, 4 modified
- Whole suite after the last commit: `pnpm test` 352 passed, `pnpm test:integration` 207 passed (idempotency file run three more times, 26/26 each), `pnpm typecheck`, `pnpm lint` and `pnpm build` clean.

## Accomplishments

- `IdempotencyStore` with the pending-entry flow from research Pitfall 4, plus a record id chosen with the entry so a takeover of an abandoned lock cannot produce a second record.
- Create handler: honeypot, validation, then key parsing and `begin()`; the plain and the idempotent path share `createdResponse` and `sendCreated`, which also build the honeypot's fake 201.
- `removeForRecord` in DELETE, closing the 02-04 flag (T-02-19 / T-02-31).
- TTL and recordId indexes on `_idempotency`, created by `ensureIndexes` with the record indexes.

## Task Commits

1. **Task 1** - `42b807c` (test, RED), `96c89b1` (feat, GREEN), `2b7a731` (refactor)

## TDD Gate Compliance

Plan type `tdd`. `test(02-07)` precedes `feat(02-07)`, followed by `refactor(02-07)`. RED evidence from real runs:

| Target test | Expected | Observed | Failing / passing in file |
|-------------|----------|----------|---------------------------|
| unit `idempotency.test.ts` | assertions on helpers | `Error: not implemented` from the throwing scaffold | 17 / 0 |
| integration `replay > returns the original 201...` | second body equals first | second POST created a new record (different id) | 22 / 4 in the file |

The RED commit carries a scaffold `idempotency.ts` whose three helpers throw, so the test files load. Because the integration tests seed entries with `entryId` and `canonicalHash`, most of the 22 integration failures in RED are the scaffold's "not implemented" rather than a behavioural assertion; the replay case above fails on the planned assertion (no idempotency yet). The four passing cases in RED (no header, header on GET, and the like) are regression cover.

## Files Created/Modified

- `src/collections/idempotency.ts` - store, `parseIdempotencyKey`, `canonicalHash`, `entryId`, `isDuplicateKey`
- `src/collections/routes.ts` - create flow, DELETE cleanup, `createdResponse` / `sendCreated`
- `src/collections/store.ts` - `insert(name, data, id?)`
- `src/collections/indexes.ts` - `_idempotency` TTL and recordId indexes
- `src/auth/api-keys.ts` - `principalOf`, set by `requireGrant`
- `test/unit/idempotency.test.ts`, `test/integration/idempotency.test.ts`

## Decisions Made

See `key-decisions` above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] The create handler needs the API key's name, which `requireGrant` did not expose**
- **Found during:** Task 1 design
- **Issue:** the entry stores the principal (T-02-30), but the onRequest hook only returned 401/403 or nothing.
- **Fix:** `requireGrant` records the resolved key name in a module-level `WeakMap`; `principalOf(request)` returns it, "anonymous" otherwise. No change to the hook's responses.
- **Files modified:** src/auth/api-keys.ts
- **Commit:** 96c89b1

No other deviations; the plan was executed as written.

## Issues Encountered

- Mongo and WebDAV were already up on the Compose stack; `pnpm` and vitest need the sandbox off here.
- The 02-04 flag (delete the idempotency entry on DELETE) is done. The entry is removed only after the record deletion succeeded; a 404 DELETE touches nothing.
- A pending entry whose `complete()` fails after the record was stored (for example a MongoDB blip) stays pending; the retry gets 409 for 30 s, then takes over and reads the stored record back. That is the designed recovery path, covered by the takeover tests.
- Plan 02-08's OpenAPI document should list the `Idempotency-Key` request header on POST, 400, 409 and 422 on create, and mention the 24 h retention.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. T-02-29 (duplicates under races and crashes), T-02-30 (cross-principal replay), T-02-31 (personal data kept) and T-02-32 (entry flooding, bounded by 02-05/02-06 limits and the TTL) are mitigated as planned. T-02-SC: no packages added.

## Next Phase Readiness

02-08 can rely on `Idempotency-Key` being accepted and documented on create only, 400/409/422 as problem+json, replayed responses carrying the original ETag, and `CORS allowedHeaders` already listing `Idempotency-Key` (02-05).

## Self-Check: PASSED

Created files `src/collections/idempotency.ts`, `test/unit/idempotency.test.ts` and `test/integration/idempotency.test.ts` exist; commits 42b807c, 96c89b1 and 2b7a731 are ancestors of HEAD.
