---
phase: 02-collections-access-policy-and-anonymous-hardening
plan: 01
subsystem: api
tags: [fastify, ajv, ajv-formats, mongodb, api-keys, sha-256, config, tdd]
requires:
  - phase: 01-foundations-ox-spike-and-storage-layer
    provides: loadConfig single-ConfigError pipeline, start() composition root, problem+json error path, Compose stack
provides:
  - "collections and apiKeys config keys; every collection and key mistake fails startup in one ConfigError"
  - "strict Ajv 2020-12 record validator (no coercion, stripping or defaults), compiled once at boot, value-free 400 problems"
  - "RecordStore over records_{name} with { _id, _v, createdAt, updatedAt, data }"
  - "KeyStore interface, ConfigKeyStore (SHA-256, timingSafeEqual over every hash), requireGrant 401/403 hook"
  - "POST /v1/{name} (anonymous or apiKey) and GET /v1/{name}/{id}; unconfigured operations answer 404"
  - "sibling-file $ref schemas inside the config directory"
  - "pnpm keygen / node dist/keygen.js"
  - "test helper collectionsApp, reused by plans 02-02 and 02-04..02-08"
affects: [02-02, 02-04, 02-05, 02-06, 02-07, 02-08, phase-03-mirror]
requirements-completed: [COLL-01, COLL-02, COLL-04, COLL-07, COLL-08, SEC-01, SEC-02]
tech-stack:
  added: ["ajv-formats@3.0.1"]
  patterns:
    - "record bodies validated in the route handler, never through Fastify route schema.body"
    - "encapsulated Fastify plugin per collection at /v1/{name}; only configured operations registered"
    - "issues are code plus JSON pointer only; a config value never reaches an issue"
key-files:
  created:
    - src/collections/validator.ts
    - src/collections/store.ts
    - src/collections/routes.ts
    - src/collections/definition.ts
    - src/auth/api-keys.ts
    - src/keygen.ts
    - test/helpers/collections-app.ts
    - test/integration/collections.test.ts
    - test/unit/api-keys.test.ts
    - test/unit/collection-config.test.ts
    - test/fixtures/config/collections/valid.yaml
    - test/fixtures/config/collections/contact.schema.json
    - test/fixtures/config/collections/invalid-many.yaml
    - test/fixtures/config/collections/broken.schema.yaml
  modified:
    - package.json
    - pnpm-lock.yaml
    - src/config/schema.ts
    - src/config/load.ts
    - src/http/logging.ts
    - src/app.ts
    - src/server.ts
key-decisions:
  - "createRecordAjv sets allowUnionTypes: true: strict mode otherwise rejects nullable fields (type: [string, null]); coercion, removal and defaults stay off"
  - "INVALID_PROPERTY_NAME ($ prefix, _ prefix, dot, empty) is checked at every depth of a schema; RESERVED_PROPERTY (id, createdAt, updatedAt) only at the root"
  - "A 400 pointer is kept only when each segment is an index into a real array in the submitted data or a property name declared anywhere in the schema"
  - "$ref files are also checked by realpath, so a symlink inside the config directory cannot lead out of it"
  - "A key hash made only of digits must be quoted in YAML (it would parse as a number and fail schema.type)"
patterns-established:
  - "collectionsApp({ collections, keys }) starts start() against its own MongoDB database and drops it on close"
  - "Semantic stages receive the `failed` pointer set and skip entries the schema stage already reported"
coverage:
  - id: D1
    description: "Anonymous POST /v1/{name} gives 201 with exactly { id, createdAt } and ETag \"1\" through start() against MongoDB"
    requirement: "COLL-08"
    verification:
      - kind: integration
        ref: "test/integration/collections.test.ts#creates anonymously with exactly { id, createdAt } and ETag 1"
        status: pass
    human_judgment: false
  - id: D2
    description: "GET /v1/{name}/{id} with a Bearer key holding the exact grant returns the flattened record; the stored document keeps user fields under data"
    requirement: "COLL-04"
    verification:
      - kind: integration
        ref: "test/integration/collections.test.ts#reads the record back with either of two keys and stores user fields under data"
        status: pass
    human_judgment: false
  - id: D3
    description: "Strict validation rejects a coerced type, an extra property and a code-point overflow, and never echoes a submitted value in the body or logs"
    requirement: "COLL-02, COLL-07"
    verification:
      - kind: integration
        ref: "test/integration/collections.test.ts#strict validation"
        status: pass
    human_judgment: false
  - id: D4
    description: "Default deny and 401/403: operations without a policy answer 404, apiKey operations answer 401 with WWW-Authenticate or 403 without the exact grant"
    requirement: "SEC-01"
    verification:
      - kind: integration
        ref: "test/integration/collections.test.ts#default deny"
        status: pass
      - kind: integration
        ref: "test/integration/collections.test.ts#authentication on the apiKey operation"
        status: pass
    human_judgment: false
  - id: D5
    description: "Keys are stored as SHA-256 hex, compared with timingSafeEqual against every configured hash, two keys with one grant both work"
    requirement: "SEC-02"
    verification:
      - kind: unit
        ref: "test/unit/api-keys.test.ts#compares every configured hash even when the first one matches"
        status: pass
    human_judgment: false
  - id: D6
    description: "Startup reports every collection and key mistake in one ConfigError at JSON pointers with no config value; sibling-file schemas load"
    requirement: "COLL-01"
    verification:
      - kind: unit
        ref: "test/unit/collection-config.test.ts"
        status: pass
    human_judgment: false
  - id: D7
    description: "pnpm keygen prints exactly two lines, key: mdra_... and hash: <64 hex>"
    verification:
      - kind: unit
        ref: "test/unit/api-keys.test.ts#prints exactly two lines, key then its hash"
        status: pass
      - kind: other
        ref: "pnpm --silent keygen and node dist/keygen.js after pnpm build"
        status: pass
    human_judgment: false
duration: 9min
completed: 2026-11-22
status: complete
commits: 4
plan_head_before: c792190ccb2d983f99d1f0d8c850a4d56db3f13e
plan_head_after: 7bc2f3508e133df738ec53530c42580df5097a34
actuals:
  tokens: 11300
  tasks: 3
  commits: 4
---

# Phase 2 Plan 01: Collections tracer Summary

**One config collection with a JSON Schema and API keys now runs end to end through `start()`: anonymous `POST /v1/{name}` returns `{ id, createdAt }`, an apiKey `GET /v1/{name}/{id}` returns the record, strict Ajv rejects without echoing input, and a deployer sees every config mistake in one startup failure.**

## Performance

- **Duration:** ~9 min
- **Started:** 2026-11-22T10:18:00Z (continuation after the Task 1 checkpoint)
- **Completed:** 2026-11-22T10:26:00Z
- **Tasks:** 3 (Task 1 approval only)
- **Files modified:** 21

## Task 1: package legitimacy approval (blocking-human)

The user replied "approved" for all five packages. Registry data pulled with `npm view` at install time, no preinstall, install or postinstall script on any of them:

| Package | Version | Published (UTC) | Repository | Installed in |
|---------|---------|-----------------|------------|--------------|
| ajv-formats | 3.0.1 | 2024-03-30 | github.com/ajv-validator/ajv-formats | this plan (done) |
| @fastify/cors | 11.4.3 | 2026-11-13 | github.com/fastify/fastify-cors | 02-05 |
| @fastify/rate-limit | 11.3.0 | 2026-11-20 | github.com/fastify/fastify-rate-limit | 02-05 |
| @fastify/swagger | 9.9.5 | 2026-11-16 | github.com/fastify/fastify-swagger | 02-08 |
| @fastify/swagger-ui | 6.1.5 | 2026-11-20 | github.com/fastify/fastify-swagger-ui | 02-08 |

Only `ajv-formats@3.0.1` was installed here, pinned exactly (`pnpm add --save-exact`); the lockfile is committed. The `@fastify/swagger-ui` package has a `prepare` script that runs only at its own publish and build time, not at install.

## Accomplishments

- Tracer (Task 2): config → startup → Fastify route → strict Ajv → MongoDB → apiKey read, verified by 14 integration tests that start the real `start()` against the Compose stack, including a canary check on every 400 body and every log line.
- Task 3: 26 issues from `invalid-many.yaml` in one `ConfigError` (acceptance asked for 18 or more), all at JSON pointers, none carrying a value; byte-identical across runs.
- Whole suite: `pnpm test` 249 passed, `pnpm test:integration` 57 passed, `pnpm typecheck` and `pnpm lint` clean, `node dist/keygen.js` works after `pnpm build`.

## Task Commits

1. **Task 1: Approve Phase 2 packages** - no commit (approval recorded here)
2. **Task 2: Tracer** - `d7f27b7` (test, RED: 14 tests fail because `collections` is an unknown config key) then `98d0b1e` (feat, GREEN)
3. **Task 3: Config errors, sibling schemas, keygen** - `d1d75f5` (test, RED: fixtures and unit tests fail) then `7bc2f35` (feat, GREEN)

No REFACTOR commit: `definition.ts` walks schema keywords by structure and `validator.ts` collects declared names generically, so there was no duplicated traversal worth merging.

**Plan metadata:** recorded in the final docs commit.

## Files Created/Modified

- `src/collections/validator.ts` - strict Ajv factory, `compileCollections`, value-free problem entries
- `src/collections/store.ts` - `RecordStore` (`insert`, `findById`) over `records_{name}`
- `src/collections/routes.ts` - `registerCollections`, one encapsulated plugin per collection
- `src/collections/definition.ts` - `resolveSchemaRefs`, `collectionIssues`, `apiKeyIssues`, `RESERVED_COLLECTION_NAMES`
- `src/auth/api-keys.ts` - `KeyStore`, `ConfigKeyStore`, `hashKey`, `KEY_PREFIX`, `requireGrant`
- `src/keygen.ts` - `generateKey` and the CLI
- `src/config/schema.ts`, `src/config/load.ts` - `collections` and `apiKeys` keys, defaults, ref and semantic stages
- `src/http/logging.ts` - `problem()` and `PROBLEM_JSON` exported, `problem()` takes value-free `errors`
- `src/app.ts`, `src/server.ts` - `collections` option; `start()` passes `{ config, db }` and logs collection names only
- `test/helpers/collections-app.ts` - `collectionsApp`

## Decisions Made

See `key-decisions` above. Beyond the plan: the `collectionsApp` helper takes the collections block as a plain object and writes it with the `yaml` package (so it still goes through `loadConfig` as YAML), and it takes `keys` as `{ name, key, grants }` so tests hold the raw key while only its hash reaches the config file.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] pnpm refused to run against the existing store**
- **Found during:** Task 2 (install)
- **Issue:** `node_modules` is linked to `node_modules/.pnpm-store/v11` while pnpm 12.21.0 wanted `~/Library/pnpm/store/v11`, so `pnpm add` stopped with a store mismatch.
- **Fix:** ran `pnpm add --save-exact ajv-formats@3.0.1 --store-dir "$PWD/node_modules/.pnpm-store/v11"`. Same package, same version; no alternative was tried.
- **Files modified:** package.json, pnpm-lock.yaml
- **Commit:** 98d0b1e

**2. [Rule 1 - Bug] Test sent a JSON content type with an empty DELETE body**
- **Found during:** Task 2 (first GREEN run)
- **Issue:** Fastify answers 400 for `content-type: application/json` with no body even on a path that does not exist, so the default-deny test failed on DELETE.
- **Fix:** the test sends the content type and body only for PUT and PATCH. Production behaviour is unchanged and consistent with an unknown path.
- **Files modified:** test/integration/collections.test.ts
- **Commit:** 98d0b1e

**3. [Rule 2 - Missing critical functionality] Nullable fields need `allowUnionTypes`**
- **Found during:** Task 3
- **Issue:** with `strict: true`, Ajv rejects `type: [string, null]` unless `allowUnionTypes` is set, which would force every deployer with an optional nullable field to fail startup.
- **Fix:** `allowUnionTypes: true` in `createRecordAjv`; coercion, removal and defaults stay off. The valid fixture schema uses a nullable field.
- **Files modified:** src/collections/validator.ts
- **Commit:** 7bc2f35

**4. [Rule 3 - Blocking] `$ref` fixture that does not parse cannot live in the repo**
- **Found during:** Task 3 (RED)
- **Issue:** `biome ci .` (part of `pnpm lint` and the acceptance criteria) fails on a fixture file that does not parse, so a broken `.json` or `.yaml` fixture cannot be committed.
- **Fix:** `broken.schema.yaml` is a valid YAML list (a schema must be an object), covering `SCHEMA_REF_INVALID` in `invalid-many.yaml`. A separate unit test writes a file that really does not parse into a temp directory and checks the same code and that no content is echoed.
- **Files modified:** test/fixtures/config/collections/broken.schema.yaml (added to the plan's file list), test/unit/collection-config.test.ts
- **Commit:** d1d75f5

---

**Total deviations:** 4 auto-fixed (1 bug, 1 missing functionality, 2 blocking)
**Impact on plan:** none on scope. `collectionIssues` takes `(document, failed)` instead of `(document, configDir, failed)` because ref resolution lives in the separate exported `resolveSchemaRefs(document, configDir)` that `load.ts` calls first.

## Issues Encountered

- Plan 02-03 ran in the same working tree and committed three commits (`429c9b4`, `6d14411`, `bb0ff86`) between this plan's RED and GREEN. `commits: 4` is the count of `(02-01)` commits in `plan_head_before..HEAD`; the raw `rev-list` range also holds the three 02-03 commits. Only this plan's files were staged, always by name.
- An all-digit key hash in YAML is read as a number. The fixture quotes it. A real SHA-256 hex is all digits with negligible probability, but the README for keygen (a later plan) should say to quote the hash.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model (new anonymous endpoint, bearer auth path and sibling-file reads are T-02-01 to T-02-07).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Plans 02-02 and 02-04..02-08 can build on `registerCollections`, `RecordStore`, `requireGrant`, `compileCollections` and `collectionsApp`. Plan 02-05 installs `@fastify/cors` and `@fastify/rate-limit`, and plan 02-08 installs `@fastify/swagger` and `@fastify/swagger-ui`, both already approved. `.planning/` was not touched by the task commits.

## TDD Gate Compliance

Plan type `tdd`. Both tasks have a `test(02-01)` RED commit that fails for the intended reason, followed by a `feat(02-01)` GREEN commit: Task 2 `d7f27b7` then `98d0b1e`, Task 3 `d1d75f5` then `7bc2f35`. No violation.

---
*Phase: 02-collections-access-policy-and-anonymous-hardening*
*Completed: 2026-11-22*

## Self-Check: PASSED

All 14 created files exist; commits d7f27b7, 98d0b1e, d1d75f5 and 7bc2f35 are ancestors of HEAD.
