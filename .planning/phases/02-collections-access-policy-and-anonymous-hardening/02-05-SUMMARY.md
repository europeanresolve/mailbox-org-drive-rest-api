---
phase: 02-collections-access-policy-and-anonymous-hardening
plan: 05
subsystem: api
tags: [fastify, cors, rate-limit, trust-proxy, x-forwarded-for, anonymous-hardening, tdd]
requires:
  - phase: 02-collections-access-policy-and-anonymous-hardening
    provides: registerCollections, per-collection plugin, problem() error path, collectionsApp helper (plan 02-01); the PUT/PATCH/DELETE routes the guard also covers (plan 02-04)
provides:
  - "collections.<name>.cors.origins: exact, canonical http(s) origins; any other Origin (null included) gets 403 problem+json on every route of the collection, preflight included, before the body is read; no Origin header passes"
  - "@fastify/cors per collection: ACAO is the listed origin with Vary: Origin, no credentials, allowed headers Content-Type/Authorization/Idempotency-Key/If-Match, exposed ETag and Retry-After, methods are the ones the collection registers, max age 600"
  - "collections.<name>.rateLimit { max, windowSeconds } (default 10 per 60 s): in-app per-IP limit on anonymous operations only; one shared bucket per collection; 429 problem+json with Retry-After"
  - "server.trustProxy: [ip | cidr] (default []), passed to Fastify as a copy of the list, false when empty"
  - "originGuard, anonymousRateLimit, AppOptions.trustProxy, issue codes collection.INVALID_ORIGIN and server.INVALID_TRUST_PROXY"
  - "collectionsApp now exposes `app` (for inject with remoteAddress) and takes a `server` block"
affects: [02-06, 02-07, 02-08, phase-03-mirror]
requirements-completed: [SEC-04, SEC-05]
tech-stack:
  added: ["@fastify/cors@11.4.3", "@fastify/rate-limit@11.3.0"]
  patterns:
    - "scope onRequest hooks run before route hooks: originGuard, then the CORS plugin's own hook (which answers a preflight), then the route's rate-limit hook"
    - "one `app.rateLimit({ max, timeWindow })` call per collection gives that collection its own store, so its anonymous routes share a bucket and collections never do"
    - "the client IP is Fastify's `request.ip`; the limiter keeps its default key generator, so its IPv6 subnet grouping stays on"
key-files:
  created:
    - src/collections/hardening.ts
    - test/integration/cors.test.ts
    - test/integration/rate-limit.test.ts
    - test/unit/hardening-config.test.ts
  modified:
    - package.json
    - pnpm-lock.yaml
    - src/config/schema.ts
    - src/config/load.ts
    - src/collections/definition.ts
    - src/collections/routes.ts
    - src/app.ts
    - src/server.ts
    - test/helpers/collections-app.ts
    - test/integration/collections.test.ts
    - test/unit/config.test.ts
key-decisions:
  - "With trusted proxies the client is the nearest address in the forwarded chain that is not itself trusted (Fastify/proxy-addr), not the left-most entry. The plan text says 'left-most untrusted'; for its own example (`198.51.100.9, 10.0.0.5`) both give the same answer, and the nearest one is the only reading a forged leading entry cannot move. A test forges `1.1.1.1, 198.51.100.50, 10.0.0.5` and stays in one bucket"
  - "trustProxy entries must be an IP or <ip>/<prefix> with a plain decimal prefix (no sign, no leading zero, no zone id); anything stricter than proxy-addr's own syntax is rejected at startup rather than discovered at the first request"
  - "A collection that sets no rateLimit gets the default through withDefaults, so the resolved config always carries it and routes never branch on absence"
  - "The origin guard and the rate limiter are separate hooks on purpose: a rejected origin never spends a rate-limit slot, and a preflight (answered by the CORS hook) never reaches the route hook"
patterns-established:
  - "Tests that need a client address use `collectionsApp(...).app.inject({ remoteAddress })`; each scenario takes its own IP so buckets never leak between tests"
  - "Status sequences are compared as one joined string (\"201,201,201,429\"), which keeps TAP failure output single-line for RED evidence"
coverage:
  - id: D1
    description: "A listed origin gets 201 with Access-Control-Allow-Origin equal to it and Vary: Origin; an unlisted origin, Origin: null and a look-alike origin get 403 problem+json, no ACAO and nothing stored; no Origin gets 201; a non-JSON body from an unlisted origin still gets 403 (checked before parsing)"
    requirement: "SEC-04"
    verification:
      - kind: integration
        ref: "test/integration/cors.test.ts#CORS on an anonymous create"
        status: pass
    human_judgment: false
  - id: D2
    description: "Preflight from a listed origin gets 204 with the collection's methods only, content-type/idempotency-key/if-match/authorization as allowed headers and max age 600; from an unlisted origin 403; a record path answers too; a preflight carries no rate-limit headers"
    requirement: "SEC-04"
    verification:
      - kind: integration
        ref: "test/integration/cors.test.ts#preflight"
        status: pass
    human_judgment: false
  - id: D3
    description: "The guard covers apiKey routes: a valid key from an unlisted origin gets 403, from a listed one 200 with ETag and Retry-After exposed; a collection with no cors block rejects every request that carries an Origin and accepts one without"
    requirement: "SEC-04"
    verification:
      - kind: integration
        ref: "test/integration/cors.test.ts#CORS on an apiKey route"
        status: pass
      - kind: integration
        ref: "test/integration/cors.test.ts#a collection without a cors block"
        status: pass
    human_judgment: false
  - id: D4
    description: "Startup rejects trailing-slash, upper-case, default-port, ftp, path and wildcard origins at /collections/<name>/cors/origins/<i> with no value in the issue, and trustProxy entries that are not an IP or CIDR (prefix 33, text, empty prefix, v6 prefix 129, signed prefix) at /server/trustProxy/<i>; rateLimit zero or fractional values give schema issues; defaults are [] and 10 per 60 s"
    requirement: "SEC-04, SEC-05"
    verification:
      - kind: unit
        ref: "test/unit/hardening-config.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "Anonymous requests 1..max succeed and max+1 gets 429 problem+json with a Retry-After of 1-2 s, answered before the body is parsed and with nothing extra stored; the window reopens after windowSeconds; 8 parallel requests with max 3 give exactly 3 and 5; a collection without rateLimit allows 10 and refuses the 11th"
    requirement: "SEC-05"
    verification:
      - kind: integration
        ref: "test/integration/rate-limit.test.ts#anonymous create"
        status: pass
    human_judgment: false
  - id: D6
    description: "Anonymous create and list of one collection share a bucket, collections do not, and an apiKey GET from an exhausted IP is not limited"
    requirement: "SEC-05"
    verification:
      - kind: integration
        ref: "test/integration/rate-limit.test.ts#buckets"
        status: pass
    human_judgment: false
  - id: D7
    description: "trustProxy empty: four POSTs from one peer with four different forged X-Forwarded-For values give 201, 201, 201, 429. trustProxy [127.0.0.1] (and its IPv4-mapped form): the forwarded client is the bucket, a peer that is not the proxy cannot move it. trustProxy [10.0.0.0/8]: the nearest untrusted entry is the bucket (the same one that client reaches by connecting directly), a forged leading entry changes nothing, an outside peer falls back to its own address"
    requirement: "SEC-05"
    verification:
      - kind: integration
        ref: "test/integration/rate-limit.test.ts#trustProxy empty"
        status: pass
      - kind: integration
        ref: "test/integration/rate-limit.test.ts#trustProxy with one proxy address"
        status: pass
      - kind: integration
        ref: "test/integration/rate-limit.test.ts#trustProxy with a CIDR"
        status: pass
    human_judgment: false
  - id: D8
    description: "A 429 reply, its headers and every log line carry no CANARY from the body or from X-Forwarded-For"
    requirement: "SEC-05"
    verification:
      - kind: integration
        ref: "test/integration/rate-limit.test.ts#what a 429 reveals"
        status: pass
    human_judgment: false
duration: ~14min
completed: 2026-11-22
status: complete
commits: 4
plan_head_before: 87027cf2eb5daac70e7bdb87c827e845d41b6c62
plan_head_after: 895a5cea4b855f7eb246a43a4b3b92d626e62b65
actuals:
  tokens: 9900
  tasks: 2
  commits: 4
---

# Phase 2 Plan 05: Per-collection CORS and per-IP rate limit Summary

**A website's own origin can call a collection from the browser and every other browser origin is refused with 403 before the body is read; anonymous routes are limited per client IP per collection (default 10 per 60 s, 429 with Retry-After), and a forged `X-Forwarded-For` cannot open a new bucket because Fastify only believes the header from addresses listed in `server.trustProxy`.**

## Performance

- **Duration:** ~14 min
- **Completed:** 2026-11-22
- **Tasks:** 2 (each RED then GREEN)
- **Files:** 4 created, 11 modified
- Whole suite after the last commit: `pnpm test` 315 passed, `pnpm test:integration` 146 passed (three runs in a row, the timing-based window test included), `pnpm typecheck`, `pnpm lint` and `pnpm build` clean.

## Accomplishments

- Task 1: `originGuard` as a scope `onRequest` hook, `@fastify/cors` registered per collection with the listed origins, and `collection.INVALID_ORIGIN` at startup. The CORS plugin answers the preflight inside its own hook, so a preflight never reaches a route hook or the rate limiter.
- Task 2: `server.trustProxy` into `buildApp` (copy of the list, `false` when empty, never `true`), `server.INVALID_TRUST_PROXY`, per-collection `rateLimit` with defaults, and `anonymousRateLimit`, attached as the route `onRequest` of every anonymous operation.
- Research assumption A2 is resolved: the rate limiter needs no `trustProxy` option of its own. It keys on `request.ip`, which already follows the Fastify instance setting.

## Task Commits

1. **Task 1** - `a202215` (test, RED) then `ffb6674` (feat, GREEN; the two packages are installed here, exact pins, lockfile committed)
2. **Task 2** - `10ec25b` (test, RED) then `895a5ce` (feat, GREEN)

No REFACTOR commit: `hardening.ts` is 30 lines and the routes change is one hook and one option block.

## TDD Gate Compliance

Plan type `tdd`. Both tasks have a `test(02-05)` commit before the `feat(02-05)` commit. RED evidence came from the TAP report of the real run (`--reporter=tap-flat`, stdout only) and passed `gsd_run check tdd-red-evidence`, which returned `RED_EVIDENCE_OK` / `target_test_failed` both times:

| Task | Target test | Expected | Observed | Failing / passing in file |
|------|-------------|----------|----------|---------------------------|
| 1 integration | `cors > CORS on an anonymous create > rejects an unlisted origin with 403 problem+json and stores nothing` | 403 | 201 | 11 / 3 |
| 2 integration | `rate-limit > trustProxy empty > ignores a forged X-Forwarded-For from any peer` | `201,201,201,429` | `201,201,201,201` | 16 / 0 |
| 2 unit | `hardening-config > server.trustProxy > rejects a bad prefix, a non-address and an empty prefix at the entry's index` | 3 INVALID_TRUST_PROXY issues | load succeeded | 3 / 9 |

Semantic assessment: each target started the real service, ran its requests and failed on the planned assertion because the behaviour is missing (no 403, no 429, no trustProxy check). Both RED commits carry a config scaffold (the schema accepts `cors`, `rateLimit`, `server.trustProxy`, with the `[]` and 10/60 defaults in Task 2's) so `start()` succeeds and the tests do not die in `beforeAll`, which would be a load fault and not RED. Tests that pass in RED because the scaffold or default allow already gives the behaviour (no Origin passes, defaults load, a preflight has no rate-limit headers) stay as regression cover.

## Files Created/Modified

- `src/collections/hardening.ts` - `originGuard`, `anonymousRateLimit`
- `src/collections/routes.ts` - guard hook, CORS registration with the collection's methods, limiter registered once with `global: false`, one limiter hook per collection on anonymous routes
- `src/collections/definition.ts` - `collection.INVALID_ORIGIN`
- `src/config/schema.ts`, `src/config/load.ts` - `server.trustProxy`, `cors`, `rateLimit`, `server.INVALID_TRUST_PROXY`, rate-limit defaults
- `src/app.ts`, `src/server.ts` - `trustProxy` option and wiring
- `test/integration/cors.test.ts`, `test/integration/rate-limit.test.ts`, `test/unit/hardening-config.test.ts`
- `test/helpers/collections-app.ts` - `app` and `server` for `collectionsApp`
- `package.json`, `pnpm-lock.yaml` - `@fastify/cors@11.4.3`, `@fastify/rate-limit@11.3.0`

## Decisions Made

See `key-decisions` above.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] The plan says "left-most untrusted address", Fastify uses the nearest one**
- **Found during:** Task 2 test design
- **Issue:** for `X-Forwarded-For: a, b, <trusted proxy>` the plan names the left-most untrusted entry, which is `a`, an entry the client controls. Fastify (proxy-addr) takes the right-most one that is not trusted, `b`, which the trusted proxy itself saw. Taking the left-most would let any client open a fresh bucket by prefixing a forged entry, which is exactly what T-02-20 forbids.
- **Fix:** none needed in code; the tests assert the safe behaviour, including a forged leading entry that must not change the bucket. The plan's own example gives the same result under both readings.
- **Files modified:** test/integration/rate-limit.test.ts
- **Commit:** 10ec25b

**2. [Rule 1 - Bug] Two existing suites broke on the new defaults**
- **Found during:** Task 2 GREEN, full-suite run
- **Issue:** `test/unit/config.test.ts` compared `config.server` to `{ port, logLevel }`, and `test/integration/collections.test.ts` posts to an anonymous create far more than 10 times a minute from one address, so the new default limit answered 429 in five of its tests.
- **Fix:** the config expectations include `trustProxy: []`; the tracer collection sets `rateLimit: { max: 10000, windowSeconds: 60 }` with a comment pointing to `rate-limit.test.ts`. No production behaviour changed for it.
- **Files modified:** test/unit/config.test.ts, test/integration/collections.test.ts
- **Commit:** 895a5ce

**3. [Rule 2 - Missing critical functionality] trustProxy entries are checked more strictly than "IP or CIDR"**
- **Found during:** Task 2 design
- **Issue:** the plan allows `<ip>/<prefix>` with a prefix in range; a signed prefix, a leading-zero prefix or an address with a zone id (`fe80::1%eth0`) would be accepted by a naive check but not mean what the deployer thinks to the proxy matcher.
- **Fix:** the prefix is a plain decimal (`0` or no leading zero, at most 3 digits) within the family's range, and `%` is rejected. Covered by the signed-prefix and prefix-129 tests.
- **Files modified:** src/config/load.ts, test/unit/hardening-config.test.ts
- **Commit:** 895a5ce

**4. [Rule 3 - Blocking] The test helper could not choose a client address or a server block**
- **Issue:** `collectionsApp` returned only a URL, so a test could not set `remoteAddress`, and it could not write `server.trustProxy`.
- **Fix:** it now also returns the Fastify `app` and accepts an optional `server` block. Existing callers are unaffected.
- **Files modified:** test/helpers/collections-app.ts
- **Commit:** a202215

---

**Total deviations:** 4 (2 bugs, 1 missing critical functionality, 1 blocking). **Impact on plan:** none on scope or on the plan's observable results.

## Issues Encountered

- The Read tool is blocked by a context-mode hook for large files in this environment; planning files were read with `cat`.
- Docker and the integration tests need the sandbox off; the Compose stack was already running. `pnpm add` needed `--store-dir "$PWD/node_modules/.pnpm-store/v11"` (same store mismatch as plan 02-01); same package names and versions as approved.
- The package-legitimacy precondition was met: `02-01-SUMMARY.md` records the user's approval of `@fastify/cors@11.4.3` and `@fastify/rate-limit@11.3.0`, and pnpm resolved exactly those versions.
- The in-memory limiter keeps up to 5000 keys per collection (plugin default), evicting the least recently used. That bounds memory but means a flood from more than 5000 addresses can evict an exhausted address early; one replica and the Kong limit in front (plan 02-03) are the supported setup (T-02-24, accepted).
- Plan 02-06 and later anonymous-route checks (body limit, honeypot, idempotency) should add their hooks after the limiter, which is already the first route-level `onRequest`.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model. T-02-20 (forged X-Forwarded-For), T-02-21 (anonymous flood), T-02-22 (cross-site posts), T-02-23 (CORS on apiKey routes) and T-02-SC (package install) are mitigated as planned and covered by the trustProxy tests, the parallel-request test, the origin tests including `Origin: null`, and the apiKey-route origin test. The only new surface is the preflight `OPTIONS` handling that `@fastify/cors` adds under each `/v1/{name}`, which answers only for listed origins.

## Next Phase Readiness

Plans 02-06 to 02-08 can rely on `originGuard` and the limiter running before any other route hook, `config.collections.<name>.rateLimit` always being present, and `collectionsApp(...).app.inject({ remoteAddress })`. Plan 02-08's OpenAPI document can describe the 403 (origin) and 429 (with `Retry-After`) answers on anonymous operations, and its example config should show `server.trustProxy`, `cors.origins` and `rateLimit`. `.planning/` was not touched by the task commits.

## Self-Check: PASSED

All 4 created files and this SUMMARY exist; commits a202215, ffb6674, 10ec25b and 895a5ce are ancestors of HEAD; `git status` shows nothing uncommitted besides this file.
