---
phase: 02-collections-access-policy-and-anonymous-hardening
verified: 2026-11-22T11:35:00Z
status: passed
score: 5/5 roadmap truths and 17/17 requirement IDs verified
covered_files:
  - ".planning/REQUIREMENTS.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-01-PLAN.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-01-SUMMARY.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-02-PLAN.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-02-SUMMARY.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-03-PLAN.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-03-SUMMARY.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-04-PLAN.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-04-SUMMARY.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-05-PLAN.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-05-SUMMARY.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-06-PLAN.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-06-SUMMARY.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-07-PLAN.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-07-SUMMARY.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-08-PLAN.md"
  - ".planning/phases/02-collections-access-policy-and-anonymous-hardening/02-08-SUMMARY.md"
  - "README.md"
  - "config/config.example.yaml"
  - "deploy/kong-check.sh"
  - "deploy/kong.yml"
  - "src/app.ts"
  - "src/auth/api-keys.ts"
  - "src/collections/definition.ts"
  - "src/collections/hardening.ts"
  - "src/collections/idempotency.ts"
  - "src/collections/if-match.ts"
  - "src/collections/indexes.ts"
  - "src/collections/list-query.ts"
  - "src/collections/merge-patch.ts"
  - "src/collections/routes.ts"
  - "src/collections/store.ts"
  - "src/collections/validator.ts"
  - "src/config/load.ts"
  - "src/config/schema.ts"
  - "src/http/docs.ts"
  - "src/keygen.ts"
  - "src/server.ts"
covered_digest: "v4:sha256:362687ce1b3d7488ee32aebd76669bfa66c79f202e39a91c7562e7b1b93b134d"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 2: Collections, Access Policy and Anonymous Hardening Verification Report

**Phase Goal:** A website can safely submit forms to anonymous create endpoints, and deployers can manage records through API-key-protected CRUD, all defined in config with default-deny access.
**Verified:** 2026-11-22T11:35:00Z
**Status:** passed
**Re-verification:** No, initial verification

Verification stance: SUMMARY claims were not trusted. The code under `src/`, `deploy/` and `config/` was read, the plans' `must_haves` artifact and key-link checks were run through `gsd-tools`, and the suites were executed in this session (results below).

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria, the contract)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Deployer defines a collection in config (JSON Schema, indexed fields, per-operation policies); startup rejects an invalid definition; `/docs` serves an OpenAPI 3.1 document and UI with per-collection schemas generated from config | ✓ VERIFIED | `src/config/schema.ts` collection schema (`schema`, `operations`, `indexes`, `bodyLimit`, `honeypot`, `rateLimit`, `cors`); `src/collections/definition.ts` `collectionIssues`/`apiKeyIssues` feed the single `ConfigError` via `load.ts` (reserved name, bad schema, open object, reserved/unsafe property, bad `$ref`, index path rules, unbounded string, honeypot rules, origin format, grants). `test/unit/collection-config.test.ts` ("reports at least 18 issues in one ConfigError", "never carries a config value"). Live check: with `docs: true` on `config/config.example.yaml`, `/docs/json` is `openapi 3.1.0`, paths `/health`, `/v1/contact`, `/v1/contact/{id}`, component schemas `contact.input`, `contact.record`, `contact.page`, `AnonymousCreated`, `Problem`, security scheme `bearerAuth` (http bearer); `/docs/` returns `text/html` and `static/swagger-ui-bundle.js` returns 200 (1.68 MB). `docs` defaults to false (see Advisory). |
| 2 | A website form POST creates a record (UUID, `createdAt`, `updatedAt`; anonymous callers get only `id` and `createdAt`); wrong type, extra property or over-long string is rejected, never coerced or stripped, as value-free `application/problem+json`; a filled honeypot is silently discarded; same `Idempotency-Key` returns the original result with no duplicate | ✓ VERIFIED | `routes.ts` create handler: strict Ajv (`validator.ts`: `strict`, `coerceTypes:false`, `removeAdditional:false`, `useDefaults:false`) called directly, not through Fastify's coercing Ajv; `anonymousResponse` returns only `{ id, createdAt }`; `honeypotFilled` returns a fake 201 built by the same `anonymousResponse` before validation and storage; `IdempotencyStore.begin` inserts a pending entry first (unique `_id`), record id chosen with the entry, replay/409/422 paths. Tests: `collections.test.ts` (strict validation, code-point `maxLength`, no echo), `anonymous-hardening.test.ts` (honeypot: fake 201, nothing stored, same shape, not bypassed by a key, log line shaped like a real create), `idempotency.test.ts` (replay, 5 parallel creates store 1 record, 409, 422, takeover reuses record id, 24 h expiry, delete clears the entry). 221 integration tests pass. |
| 3 | API consumer gets a record by ID, lists with cursor pagination and equality/range filters on indexed fields only (non-indexed field rejected), replaces (PUT), merge-patches (RFC 7396, validated after merge) and deletes | ✓ VERIFIED | `routes.ts` get/list/replace/patch/delete handlers; `list-query.ts` `parseListQuery` (allow-listed fields from config only, typed values, cursor encode/decode, limit 1..200, unknown or repeated parameter rejected); `store.list` builds keyset filter from typed conditions only; `merge-patch.ts` `applyMergePatch` (RFC 7396, `__proto__`-safe via `defineProperty`), merged value re-validated before `store.replace`, which is one atomic `findOneAndUpdate` filtered on `_v`; PATCH retries 3 times then 409. Hard delete `deleteOne`, 404 on absent id, 204 on success. Tests: `collections-list.test.ts` (7-record paging, exact multiple, insert between pages, ties, tampered cursor, 400 for non-indexed filter, indexes created), `collections-write.test.ts` (If-Match strong comparison, two PUTs give one 200 and one 412, concurrent PATCH both land, 3 lost races give 409, `__proto__` rejected, 415 mismatched media types). |
| 4 | Every operation is denied unless `anonymous` or `apiKey`; missing or wrong key rejected; keys stored hashed and compared in constant time; two keys active at once for rotation | ✓ VERIFIED | `routes.ts` only registers operations present in `definition.operations`; an unset operation is an unregistered route (404). `api-keys.ts`: SHA-256 of whole key, `timingSafeEqual` against every configured hash without early exit, `KEY_PATTERN` gate, `requireGrant` gives 401 (+`WWW-Authenticate: Bearer`) or 403 for a missing grant; config schema accepts only 64-hex hashes, `apiKeyIssues` rejects duplicate hashes and unknown/wildcard grants; `keygen.ts` prints `mdra_` key and hash. Tests: `api-keys.test.ts` ("compares every configured hash even when the first one matches"), `collections.test.ts` (401/403 cases, "reads the record back with either of two keys", 404 for operations without a policy). |
| 5 | Anonymous endpoints reject an oversized body, a non-JSON content type, a disallowed browser origin; per-IP rate limit holds against a forged `X-Forwarded-For`; Kong reference config in `deploy/` rate-limits and logs only method, route and status | ✓ VERIFIED | `hardening.ts` `requireMediaType` (415 before body read), `originGuard` (403 incl. `Origin: null`, preflight included), `anonymousRateLimit` keyed on `request.ip`; `app.ts` passes `trustProxy` only when the configured list is non-empty (never `true`); `bodyLimit` per route (default 16384, max 1048576). Tests: `anonymous-hardening.test.ts` (413 at limit+1, exact limit accepted, chunked body stopped, 415 before parsing), `cors.test.ts`, `rate-limit.test.ts` ("ignores a forged X-Forwarded-For from any peer", "is not moved by a forged entry in front of the real client", 20 parallel give exactly 10 successes). `deploy/kong-check.sh` was run in this session against `kong:3.9.5`: config parses, canary in path/query/header/body absent from logs, client address absent, one JSON line with POST/collections-write/201, first 429 at request 11: `PASS`. |

**Score:** 5/5 roadmap truths verified; 0 present-but-behavior-unverified.

### PLAN `must_haves` truths (merged, not narrowing the roadmap)

All eight plans' truths were checked against code and named tests. Behavior-dependent truths (concurrency, version races, takeover of an abandoned idempotency entry, rate-limit under parallel load, cancellation of abandoned entries on failed store) each have a passing behavioral test, so none is left at presence-only.

| Plan | Truth group | Status | Behavioral evidence |
|------|-------------|--------|---------------------|
| 02-01 | Tracer: anonymous POST 201 `{id, createdAt}`; GET with grant; strict validation; 401/403/404 rules; hashed keys; keygen; one `ConfigError` for all collection/key issues | ✓ VERIFIED | `collections.test.ts`, `api-keys.test.ts`, `collection-config.test.ts` |
| 02-02 | List, filters, sort, cursor, index creation, index-path config rules | ✓ VERIFIED | `collections-list.test.ts`, `list-query.test.ts`, `list-config.test.ts` |
| 02-03 | Kong config and behavioural check; SEC-07 recorded dropped; README CAPTCHA/trustProxy text | ✓ VERIFIED | `deploy/kong-check.sh` run: PASS; `REQUIREMENTS.md` Out of Scope row and traceability `Dropped`; no CAPTCHA clause left in ROADMAP Phase 2 criteria; README sections "Anonymous form submission" and "Gateway (Kong)" |
| 02-04 | PUT, PATCH, DELETE, If-Match, ETag, 404/412/415/409 rules | ✓ VERIFIED | `collections-write.test.ts`, `merge-patch.test.ts`, `if-match.test.ts` |
| 02-05 | Per-collection CORS, per-IP in-app rate limit, `trustProxy` list and config checks | ✓ VERIFIED | `cors.test.ts`, `rate-limit.test.ts`, `hardening-config.test.ts` |
| 02-06 | Body limit, media type, unbounded-string startup check, honeypot | ✓ VERIFIED | `anonymous-hardening.test.ts`, `form-config.test.ts` |
| 02-07 | Idempotency-Key: replay, 409, 422, TTL, crash takeover, delete cleanup, scoping | ✓ VERIFIED | `idempotency.test.ts`, `idempotency.test.ts` (unit) |
| 02-08 | `/docs`, example config, README, end-to-end canary sweep | ✓ VERIFIED | `docs.test.ts`, `config-example.test.ts`, `collections-canary.test.ts` |

### Required Artifacts (Level 1-3)

`gsd_run query verify.artifacts` and `verify.key-links` for each plan:

| Plan | Artifacts | Key links |
|------|-----------|-----------|
| 02-01 | 7/7 pass | 4/4 verified |
| 02-02 | 3/3 pass | 3/3 verified |
| 02-03 | 2/2 pass | 1/1 verified |
| 02-04 | 3/3 pass | 2/2 verified |
| 02-05 | 2/2 pass | 2/2 verified |
| 02-06 | 2/2 pass | 1/1 verified |
| 02-07 | 2/2 pass | 2/2 verified |
| 02-08 | 3/3 pass | 2/2 verified |

Wiring read manually in `src/app.ts` (`registerDocs` before `registerHealthRoutes` and `registerCollections`, `trustProxy` from options) and `src/server.ts` (`collections: { config, db }`, `trustProxy: config.server.trustProxy`, `docs: config.server.docs`, `scheduleIndexSetup(ensureIndexes)` not awaited so `/health` never depends on it). No orphaned artifact.

### Data-Flow Trace (Level 4)

| Artifact | Data | Source | Real data | Status |
|----------|------|--------|-----------|--------|
| `routes.ts` create/get/list/replace/patch | records | `RecordStore` on `records_<name>` through `db` from `mongo.client.db()` | Yes: insert, `findOne`, keyset `find`, `findOneAndUpdate`, `deleteOne` | ✓ FLOWING |
| `routes.ts` anonymous create reply | `{ id, createdAt }` | the inserted document | Yes | ✓ FLOWING |
| `idempotency.ts` replay | stored response | `_idempotency` collection | Yes | ✓ FLOWING |
| `http/docs.ts` | paths and components | `config.collections` | Yes (live check above) | ✓ FLOWING |
| `ConfigKeyStore` | key hashes | `config.apiKeys` loaded by `loadConfig` | Yes | ✓ FLOWING |

### Behavioral Spot-Checks and Test Runs (run in this session)

| Check | Command | Result | Status |
|-------|---------|--------|--------|
| Unit suite | `pnpm test` | 23 files, 373 tests passed | ✓ PASS |
| Integration suite (existing Compose stack: MongoDB 8 and WebDAV, per-run database) | `pnpm test:integration` | 12 files, 221 tests passed | ✓ PASS |
| Typecheck | `pnpm typecheck` | clean | ✓ PASS |
| Lint and format | `pnpm lint` | `biome ci`: 86 files, no findings (the lint error 02-03 deferred is gone) | ✓ PASS |
| Kong reference config | `bash deploy/kong-check.sh` | `PASS: deploy/kong.yml parses, keeps request data out of logs and rate-limits` | ✓ PASS |
| OpenAPI generation | script built the app from `config/config.example.yaml` with `docs: true` | `openapi 3.1.0`, expected paths and components, bearer scheme, UI and bundle served | ✓ PASS |

Note: the unit run inside the sandbox failed one test (`config.test.ts` "start with a valid config") with `uv_interface_addresses` (a sandbox network-interface restriction in Fastify's listen logging). It passed 373/373 outside the sandbox, so it is an environment artefact, not a code defect.

### Probe Execution

No `scripts/*/tests/probe-*.sh` exist and the plans declare none. The phase-declared behavioural script `deploy/kong-check.sh` was run (see above). No MISSING_PROBE.

### Requirements Coverage and REQUIREMENTS traceability cross-check

Every requested ID appears in at least one plan's `requirements:` frontmatter, has a row in the REQUIREMENTS.md traceability table mapped to Phase 2, and has a ticked checkbox in the v1 list. SEC-07 is correctly out of scope.

| Requirement | Source plan(s) | Traceability row | Status | Evidence |
|-------------|----------------|------------------|--------|----------|
| COLL-01 | 02-01, 02-08 | Phase 2, Complete | ✓ SATISFIED | config schema, `definition.ts`, example config test |
| COLL-02 | 02-01 | Phase 2, Complete | ✓ SATISFIED | strict Ajv; server UUID and timestamps in `store.insert` |
| COLL-03 | 02-02 | Phase 2, Complete | ✓ SATISFIED | `list-query.ts`, `store.list`, `collections-list.test.ts` |
| COLL-04 | 02-01, 02-04 | Phase 2, Complete | ✓ SATISFIED | GET by id, 404 for unknown or malformed id, ETag |
| COLL-05 | 02-04 | Phase 2, Complete | ✓ SATISFIED | PUT and PATCH, `merge-patch.ts`, validated after merge |
| COLL-06 | 02-04 | Phase 2, Complete | ✓ SATISFIED | hard delete, 204/404, idempotency entry removed |
| COLL-07 | 02-01, 02-08 | Phase 2, Complete | ✓ SATISFIED | `reject()` and `problem()` send fixed text and keywords; canary sweep over every error status |
| COLL-08 | 02-01 | Phase 2, Complete | ✓ SATISFIED | `anonymousResponse` returns only `id`, `createdAt` |
| SEC-01 | 02-01 | Phase 2, Complete | ✓ SATISFIED | unset operation never registered; policy enum is `anonymous` or `apiKey` |
| SEC-02 | 02-01 | Phase 2, Complete | ✓ SATISFIED | hashed, `timingSafeEqual`, multiple keys |
| SEC-03 | 02-06 | Phase 2, Complete | ✓ SATISFIED | `bodyLimit`, `requireMediaType`, `UNBOUNDED_STRING` startup check on anonymous writes |
| SEC-04 | 02-05 | Phase 2, Complete | ✓ SATISFIED | `originGuard`, `@fastify/cors`, canonical-origin config check |
| SEC-05 | 02-05 | Phase 2, Complete | ✓ SATISFIED | `anonymousRateLimit`, `trustProxy` list, forged-XFF tests |
| SEC-06 | 02-06 | Phase 2, Complete | ✓ SATISFIED | `honeypotFilled`, fake 201 |
| SEC-07 | 02-03 (drop record) | Phase 2, **Dropped**; listed under Out of Scope with the D-07 reason | ✓ ACCOUNTED (dropped by decision D-07) | not implemented by design; README states CAPTCHA is the caller's job |
| SEC-08 | 02-07 | Phase 2, Complete | ✓ SATISFIED | `idempotency.ts`, `idempotency.test.ts` |
| SEC-09 | 02-03 | Phase 2, Complete | ✓ SATISFIED | `deploy/kong.yml`, `deploy/kong-check.sh` passes |
| FND-04 | 02-08 | Phase 2, Complete | ✓ SATISFIED | `src/http/docs.ts`, `docs.test.ts`, live check |

Orphaned requirements: none. REQUIREMENTS.md maps no other ID to Phase 2 that is missing from a plan. Totals: 49 v1 requirements (FND 5, DEV 4, STOR 5, COLL 8, SEC 8 excluding SEC-07, MIRR 8, READ 11), all mapped; the "49 total, 0 unmapped" claim is correct.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | - | No `TBD`, `FIXME`, `XXX`, `TODO`, `HACK`, placeholder text or stub handlers in `src/`, `deploy/`, `config/` | - | - |

The `return null` hits in `api-keys.ts` and `validator.ts` are real control flow (key not found, schema valid), not stubs.

### Human Verification Required

None. The one blocking human checkpoint in the phase (02-01 Task 1, approving the five new packages) was approved by the user and recorded in `02-01-SUMMARY.md`. No `<human-check>` blocks exist in any plan. The Swagger UI is a third-party bundle; the check here confirms it is served (HTML and JS asset return 200), not how it looks in a browser.

### Advisory and Notes (non-blocking)

| # | Finding | Category | Why advisory |
|---|---------|----------|--------------|
| 1 | `server.docs` defaults to `false`, so ROADMAP criterion 1's "API consumer can open `/docs`" holds only after a deployer sets `server.docs: true`. This was a recorded discretion decision (CONTEXT.md, smaller public surface), is documented in the example config and README, and is tested both ways. | scope reading | Matches the CONTEXT discretion; no change needed unless the product owner wants docs on by default |
| 2 | `ROADMAP.md` Progress table still shows Phase 2 as "8/8, In Progress" with no completion date, while the phase list ticks all eight plans. | housekeeping | Update when the orchestrator closes the phase |
| 3 | SEC-03's "required `maxLength` on strings" is enforced as a startup rejection only when an anonymous `create`, `replace` or `patch` exists. An `apiKey`-only collection may have unbounded strings (bounded by `bodyLimit` instead). | design reading | Matches the CONTEXT.md expected reading ("startup rejection of anonymous-create schemas") |
| 4 | `deploy/kong-check.sh` is deliberately not part of CI (needs Docker and the Kong image). It passes locally today but nothing guards regressions of `deploy/kong.yml`. | CI coverage | Plan 02-03 states it is a reference artefact |

### Gaps Summary

No gaps. Every ROADMAP success criterion and every requirement ID in scope (COLL-01..08, SEC-01..06, SEC-08, SEC-09, FND-04) is implemented, wired to the running service through `start()`, and backed by passing behavioral tests; SEC-07 is cleanly dropped and recorded in REQUIREMENTS.md (Out of Scope and traceability `Dropped`). The phase goal (anonymous forms safely submitted, API-key-protected CRUD, config-defined, default-deny) is achieved in the codebase.

---

_Verified: 2026-11-22T11:35:00Z_
_Verifier: Claude (gsd-verifier)_
