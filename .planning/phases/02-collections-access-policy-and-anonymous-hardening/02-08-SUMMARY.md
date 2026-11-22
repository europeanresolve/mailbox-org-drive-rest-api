---
phase: 02-collections-access-policy-and-anonymous-hardening
plan: 08
subsystem: api
tags: [openapi, swagger, fastify, docs, readme, example-config, canary, tdd]
requires:
  - phase: 02-collections-access-policy-and-anonymous-hardening
    provides: collection routes and operations (02-01..02-04), CORS, rate limit, body limit, honeypot (02-05, 02-06), Idempotency-Key with 400/409/422 (02-07), list-query constants (02-02)
provides:
  - "server.docs (default false): OpenAPI 3.1.0 document at /docs/json and UI at /docs, generated from config; with docs off both answer 404 problem+json (FND-04, D-04)"
  - "registerDocs(app, config, { ready }) in src/http/docs.ts; AppOptions.docs; start() passes config.server.docs"
  - "per-collection components <name>.input, <name>.record, <name>.page plus AnonymousCreated and Problem and an http bearer scheme; internal $ref rewritten into the collection's component"
  - "config/config.example.yaml with a synthetic contact collection using every collection key, a website-backend key with a 64-zero placeholder hash, and commented trustProxy and docs (COLL-01)"
  - "README: collections, routes, status codes, list syntax, If-Match, Idempotency-Key, honeypot, keygen, /docs, and the anonymous get/list exposure warning"
  - "Phase 2 end-to-end canary sweep through start() across every Phase 2 error status (COLL-07)"
affects: [phase-03-mirror, phase-04-read-only-content]
requirements-completed: [FND-04, COLL-01, COLL-07]
tech-stack:
  added: ["@fastify/swagger@9.9.5", "@fastify/swagger-ui@6.1.5"]
  patterns:
    - "the whole OpenAPI paths and components object is built from config in transformObject; swagger's route-schema pipeline hides every route and is never fed a collection route"
    - "document constants (limit minimum, maximum, default; filter operators) are imported from list-query.ts and definition.ts, never restated"
key-files:
  created:
    - src/http/docs.ts
    - test/unit/docs.test.ts
    - test/unit/config-example.test.ts
    - test/integration/collections-canary.test.ts
  modified:
    - package.json
    - pnpm-lock.yaml
    - src/app.ts
    - src/server.ts
    - src/config/schema.ts
    - src/config/load.ts
    - config/config.example.yaml
    - README.md
    - test/unit/config.test.ts
key-decisions:
  - "Paths and component schemas are written by transformObject from config, and the swagger transform hides every route: running collection routes through swagger's pipeline would rewrite $ref, drop $id/$schema and need route schemas, which would switch on fast-json-stringify (02-01)"
  - "/health and /ready are documented from fixed definitions in docs.ts, /ready only when readiness checks are registered: swagger's onRoute hook misses routes registered synchronously before its plugin loads"
  - "<name>.record is the input schema with id, createdAt and updatedAt added to properties and required (not allOf), so a closed input schema does not make the record unsatisfiable; its $refs keep pointing into <name>.input/$defs"
  - "Error responses are listed per operation as the code can really produce them (for example no 400 on DELETE, 429 only on anonymous operations, 403 on every operation because of the origin guard) rather than a uniform 400 and 404 everywhere"
  - "docs are registered only when both docs is true and collections are given, since the document needs the config"
patterns-established:
  - "sweep(): one request, status and problem+json check, no canary in body or headers, exactly one request log line with a route template"
coverage:
  - id: D1
    description: "With server.docs true, /docs/json is OpenAPI 3.1.0 with a bearer scheme and per-collection input, record and page components; contact.input equals the configured schema except $refs now point into the component; refs all resolve; config-order, byte-identical output; empty-collections document has only /health and /ready"
    requirement: "FND-04"
    verification:
      - kind: unit
        ref: "test/unit/docs.test.ts#GET /docs/json"
        status: pass
    human_judgment: false
  - id: D2
    description: "Exactly the configured operations are documented under /v1/{name} and /v1/{name}/{id}; anonymous operations declare security [] and apiKey operations bearerAuth; preflight, trailing-slash and UI routes are absent; Idempotency-Key on create, If-Match on PUT and PATCH, merge-patch media type, list limit 1/200/50 from the constants, cursor, sort and indexed filters, problem+json errors including 409 and 422 on create"
    requirement: "FND-04"
    verification:
      - kind: unit
        ref: "test/unit/docs.test.ts#GET /docs/json"
        status: pass
    human_judgment: false
  - id: D3
    description: "server.docs defaults to false, rejects a non-boolean with schema.type at /server/docs; with docs off /docs, /docs/json and /docs/yaml are 404 problem+json; GET /docs is text/html; start() wires the key"
    requirement: "FND-04"
    verification:
      - kind: unit
        ref: "test/unit/docs.test.ts#server.docs config key"
        status: pass
      - kind: integration
        ref: "test/integration/collections-canary.test.ts#server.docs through start()"
        status: pass
    human_judgment: false
  - id: D4
    description: "config.example.yaml loads with its placeholders set, has a collection using schema, operations, indexes, honeypot, cors, rateLimit and bodyLimit, a placeholder key of 64 zeros that points to pnpm keygen, commented trustProxy and docs, and only synthetic data"
    requirement: "COLL-01"
    verification:
      - kind: unit
        ref: "test/unit/config-example.test.ts"
        status: pass
      - kind: unit
        ref: "test/unit/synthetic-data.test.ts#tracked files"
        status: pass
    human_judgment: false
  - id: D5
    description: "The canary appears in no response body, header or log line across 400 (create, list, PATCH), 401, 403 (grant, origin), 404, 412, 413, 415, 429 and the honeypot 201; every error is problem+json and every request wrote one log line with a route template; no raw API key reaches a log"
    requirement: "COLL-07"
    verification:
      - kind: integration
        ref: "test/integration/collections-canary.test.ts#Phase 2 error paths never echo the canary"
        status: pass
    human_judgment: false
  - id: D6
    description: "README documents collections, routes, status codes, list syntax, If-Match, Idempotency-Key, honeypot, keygen and /docs, and warns that get or list set to anonymous exposes records to anyone"
    requirement: "COLL-01"
    verification: []
    human_judgment: true
    rationale: "Prose accuracy against the API was checked by reading the code paths, but whether the README reads well for a deployer is a human judgement"
duration: ~25min
completed: 2026-11-22
status: complete
commits: 7
plan_head_before: dcdc44d2d093295474b4e953cca23b2849fc1bd4
plan_head_after: 3f58f2cf9a97593eaf014edf582b579be79ce34e
actuals:
  tokens: 15000
  tasks: 2
  commits: 7
---

# Phase 2 Plan 08: OpenAPI at /docs, example config, README and end-to-end canary Summary

**With `server.docs: true` an integrator gets an OpenAPI 3.1 document and UI at `/docs` that lists exactly what the config allows (schemas, `Idempotency-Key`, `If-Match`, problem+json errors); the example config and README now match the real API; and a sweep through `start()` shows no Phase 2 error path echoes a submitted value.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-11-22
- **Tasks:** 2 (both TDD)
- **Files:** 4 created, 9 modified
- Whole suite after the last commit: `pnpm test` 373 passed, `pnpm test:integration` 221 passed (canary file re-run three more times, all green), `pnpm typecheck`, `pnpm lint` and `pnpm build` clean.

## Accomplishments

- `src/http/docs.ts`: builds the whole `paths` and `components` objects from config. Component names are `<name>.input`, `<name>.record`, `<name>.page`, `AnonymousCreated` and `Problem`, in config order, so two runs give identical bytes.
- Every `$ref` in a collection schema (`#`, `#/$defs/x`) is rewritten to point inside `<name>.input`; a test with `$defs` walks all refs and checks each resolves.
- Per operation: security (`[]` for anonymous, `bearerAuth` for apiKey), request media type (`application/merge-patch+json` for PATCH), success response (anonymous create shows only id and createdAt), `Idempotency-Key` header and 400, 409, 422 on create with the 24 h retention (the 02-07 SUMMARY note), `If-Match` on PUT and PATCH, and list parameters: `limit` (min 1, max 200, default 50 imported from `list-query.ts`), `cursor`, `sort` as an enum, and equality plus range filters for `createdAt`, `updatedAt` and each indexed field.
- `config.example.yaml` gained a synthetic `contact` collection, a `website-backend` key and commented `trustProxy` and `docs`; `README.md` replaced the illustrative config and endpoint sketch with the real keys and routes and added the sections listed in the plan.
- `collections-canary.test.ts`: 14 cases through `start()` including one for `server.docs` wiring.

## Task Commits

1. **Task 1** - `dbf9428` (test, RED), `19a1cee` (feat, GREEN)
2. **Task 2** - `c587f6a` (test, RED), `b345e85` (docs, example config), `f1286b6` (docs, README), `c3a844e` (docs, format fix), `3f58f2c` (test, typecheck fix)

## TDD Gate Compliance

Plan type `tdd`. `test(02-08)` precedes `feat(02-08)` for Task 1; for Task 2 `test(02-08)` precedes the `docs(02-08)` example config. RED evidence from real runs:

| Target test | Expected | Observed | Failing / passing in file |
|-------------|----------|----------|---------------------------|
| unit `docs.test.ts` | document and `server.docs` | `ConfigError` at `/server/docs` (key unknown) | 14 / 1 |
| unit `config-example.test.ts` | example has a collection and key | no `collections`, no `apiKeys`, no comments | 5 / 1 |

The canary sweep (`collections-canary.test.ts`) tests behaviour 02-01..02-07 already implement, so it was green from the first correct run, as the plan expects of a regression sweep; its only failure while writing was a wrong assumption in the test itself (two valid string filters are not a 400), fixed before the commit.

## Files Created/Modified

- `src/http/docs.ts` - `registerDocs`, schema and path builders
- `src/app.ts`, `src/server.ts` - `docs` option and its wiring
- `src/config/schema.ts`, `src/config/load.ts` - `server.docs`, default false
- `config/config.example.yaml`, `README.md`
- `test/unit/docs.test.ts`, `test/unit/config-example.test.ts`, `test/integration/collections-canary.test.ts`, `test/unit/config.test.ts` (expects `docs: false` in the resolved server block)
- `package.json`, `pnpm-lock.yaml` - the two approved packages, exact pins

## Decisions Made

See `key-decisions` above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] A swagger `transform` cannot document the collection routes, and `/health` and `/ready` were missed by the onRoute hook**
- **Found during:** Task 1 GREEN
- **Issue:** the plan has a `transform` return the schema for each collection route and keep `/health` and `/ready` from their routes. Swagger's own pipeline rewrites `$ref` (`definitions` to `components/schemas`), deletes `$id` and `$schema` and resolves refs through json-schema-resolver, so a ref to `#/components/schemas/contact.input/$defs/x` is not safe to pass through it. Separately, `/health` and `/ready` are registered synchronously before swagger's plugin loads, so its onRoute hook never saw them and the first GREEN run listed only `/v1` paths.
- **Fix:** `transform` hides every route; `transformObject` returns the finished document with `paths` and `components.schemas` written by `docs.ts` from config. `/health` and `/ready` have fixed definitions there, `/ready` only when `buildApp` was given readiness checks (`registerDocs(app, config, { ready })`). `registerDocs` is synchronous. Behaviour in the test is as the plan lists it.
- **Files modified:** src/http/docs.ts, src/app.ts
- **Commit:** 19a1cee

**2. [Rule 1 - Bug] Existing config tests expected the old `server` shape**
- **Found during:** Task 1 GREEN full suite
- **Issue:** `test/unit/config.test.ts` compares the resolved `server` block with `toEqual`; the new `docs: false` default broke three expectations.
- **Fix:** the three expectations include `docs: false`.
- **Files modified:** test/unit/config.test.ts
- **Commit:** 19a1cee

**3. [Rule 3 - Blocking] `pnpm add` refused the existing store location**
- **Found during:** Task 1 install
- **Issue:** `ERR_PNPM_UNEXPECTED_STORE`: `node_modules` is linked to the in-repo store `node_modules/.pnpm-store`, pnpm wanted the global one.
- **Fix:** `pnpm add --save-exact --store-dir node_modules/.pnpm-store @fastify/swagger@9.9.5 @fastify/swagger-ui@6.1.5`. Both versions are the ones approved in 02-01 (the precondition holds: the 02-01 SUMMARY records "approved" for all five packages); the lockfile is committed.
- **Commit:** 19a1cee

### Differences in what is documented

- The plan's behaviour line says every operation lists "at least 400 and 404". The document lists what each operation can produce instead (for example no 400 on DELETE, no 404 on create), because a documented status the code never returns misleads integrators. Every status of 400 or more, wherever listed, is `application/problem+json` referencing `Problem`, which is what the test asserts.
- `<name>.record` is the input schema extended with the three server fields, not an `allOf` over it, because a closed input schema (`additionalProperties: false`) would otherwise make every record invalid against its own schema.

## Auth Gates

None.

## Issues Encountered

- Docker, pnpm and vitest need the sandbox off here; MongoDB and WebDAV were already up on the Compose stack.
- Biome formats YAML: aligned trailing comments in the example config were rewritten, so the per-operation route notes sit on their own comment lines.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. T-02-33 (disclosure through `/docs`) is mitigated as planned: off by default, denied operations never appear, README states the trade-off and points at the Kong `docs` route. T-02-34 is covered by the sweep. T-02-35: assets come from the installed package, no external script origin (the UI test checks the page for external script URLs). T-02-36: the example key is 64 zeros with a `pnpm keygen` comment. T-02-SC: the two packages are the approved, exactly pinned ones.

## Next Phase Readiness

Phase 2 is complete: collections, access policy, anonymous hardening, idempotency, `/docs`, example config and README are in place. Phase 3 (mirror worker) can read records from `records_<name>`; the canary harness in `collections-canary.test.ts` is the place to extend with mirror error paths.

## Self-Check: PASSED

Created files `src/http/docs.ts`, `test/unit/docs.test.ts`, `test/unit/config-example.test.ts` and `test/integration/collections-canary.test.ts` exist; commits dbf9428, 19a1cee, c587f6a, b345e85, f1286b6, c3a844e and 3f58f2c are ancestors of HEAD.
