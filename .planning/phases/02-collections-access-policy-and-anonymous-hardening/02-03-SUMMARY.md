---
phase: 02-collections-access-policy-and-anonymous-hardening
plan: 03
subsystem: infra
tags: [kong, gateway, rate-limiting, privacy, docs]

requires:
  - phase: 01-foundation
    provides: docker-compose dev stack (Docker is already a project prerequisite)
provides:
  - deploy/kong.yml, a DB-less Kong reference config (kong:3.9.5) with per-IP rate limits and method/route/status-only logging
  - deploy/kong-check.sh, a Docker behavioural check that proves the config parses, leaks no request data into logs and returns 429
  - README sections on anonymous form submission and the Kong gateway with the server.trustProxy pairing
  - SEC-07 (in-API CAPTCHA) recorded as dropped per D-07 in REQUIREMENTS and ROADMAP
affects: [02-05 trustProxy and in-app rate limit, 02-08 docs toggle]

actuals:
  tokens: 9500
  tasks: 2
  commits: 2
plan_head_before: d7f27b7
plan_head_after: 6d14411

tech-stack:
  added: [kong:3.9.5 (reference artefact only, not shipped)]
  patterns: ["behavioural canary check for log privacy", "custom_fields_by_lua returning nil to remove serializer fields"]

key-files:
  created: [deploy/kong.yml, deploy/kong-check.sh]
  modified: [README.md, .planning/REQUIREMENTS.md, .planning/ROADMAP.md]

key-decisions:
  - "Kong file-log removes request-carrying fields by returning nil from custom_fields_by_lua (confirmed against kong:3.9.5, resolving research assumption A1)"
  - "Route-scoped rate-limiting (10/min) on collections-write overrides the global 120/min instance"
  - "Kong image pinned to the exact tag 3.9.5 (docker manifest inspect confirmed it exists; 3.9.6+ does not)"

patterns-established:
  - "Privacy checks use a canary string in path, query, header and body, and assert it never reaches logs"

requirements-completed: [SEC-09, SEC-07]

duration: 20min
completed: 2026-11-22
status: complete
---

# Phase 2 Plan 03: Kong reference gateway and SEC-07 drop Summary

**DB-less Kong 3.9.5 reference config that rate-limits per client IP and logs only method, route and status, proven by a canary behavioural check; in-API CAPTCHA (SEC-07) recorded as dropped per D-07.**

## Performance

- **Duration:** about 20 min
- **Tasks:** 2 of 2
- **Files:** 2 created, 3 modified

## Accomplishments

- `deploy/kong.yml` (`_format_version: "3.0"`): service `mailbox-org-drive-rest-api` at `http://api:3000`; routes `collections-write` (POST /v1), `api` (GET/HEAD/PUT/PATCH/DELETE/OPTIONS /v1), `probes` (/health, /ready), `docs` (/docs). Rate-limiting by IP, 10/min on `collections-write` and 120/min globally; request-size-limiting 64 KB on `collections-write`; file-log to stdout. Every block is commented, with the required `KONG_*` runtime settings at the top (including `KONG_PROXY_ACCESS_LOG=off`).
- `deploy/kong-check.sh` runs `kong config parse`, a stub upstream answering 201, then Kong. It sends one POST with a canary in path, query, header and body, and fails if any log line contains the canary or the client address (learned from the `X-Forwarded-For` the stub receives). It requires exactly one JSON line with method POST, route `collections-write`, status 201 and none of the removed fields, then asserts the first 429 is request 11. It waits out minute boundaries because Kong's local window is clock-aligned. Cleanup is by trap.
- README: "Anonymous form submission" (CAPTCHA is the caller's job, protections listed) and "Gateway (Kong)" (run command, env settings, `server.trustProxy` pairing with the D-10 caveat, how to run the check).
- REQUIREMENTS.md: SEC-07 removed from Access & Hardening, added to Out of Scope with the D-07 reason, traceability row `Dropped`, coverage 49, "Last updated" note. ROADMAP.md: criterion 2 loses the CAPTCHA clause, Requirements line drops SEC-07.

## Verification

- `bash deploy/kong-check.sh`: PASS. Logged line: `{"status":201,"started_at":...,"method":"POST","workspace_name":"default","upstream_status":"201","route":"collections-write","workspace":"...","source":"upstream","latencies":{...}}`.
- Negative control: with the `request` and `client_ip` removals deleted from a temp copy of kong.yml, the script fails with "a Kong log line contains the canary", so the check is not vacuous.
- Task 2 automated verify and all acceptance greps pass.
- `pnpm lint`: one error, in `src/collections/validator.ts` (import order), a file from the parallel plan 02-01 that is not part of this plan. See Deferred Issues.

## Task Commits

1. **Task 1: Kong reference config and behavioural check** - `429c9b4` (feat)
2. **Task 2: SEC-07 dropped, README anonymous and gateway sections** - `6d14411` (docs)

## Deviations from Plan

### Auto-fixed Issues

None - plan executed as written. Small choices within the plan's latitude:

- The check script's stub bind address defaults to 127.0.0.1 as specified, with a `STUB_BIND` override because on Linux Docker Engine `host-gateway` cannot reach a loopback-only listener.
- The log removes `service` and `consumer` as well as `request`, `response`, `client_ip`, `upstream_uri`, `tries`. `route` is replaced by the route name string.
- `acceptance` text said `git diff --stat <docs-sha>^..<docs-sha>`: the docs commit changed ROADMAP.md by 2 lines and REQUIREMENTS.md by 5 lines (4 insertions plus the removal), all of them the specified edits.

## Deferred Issues

- `pnpm lint` fails on import ordering in `src/collections/validator.ts` (plan 02-01's uncommitted work in the shared tree). Out of scope for 02-03; the owner of that file should run `biome check --write`.

## Known Stubs

None.

## Threat Flags

None. T-02-12 (log leakage) and T-02-13 (DoS) are mitigated and proven by the check; T-02-14 mitigated by README guidance (test lands in 02-05); T-02-SC mitigated by the pinned, verified tag.

## Self-Check: PASSED

- FOUND: deploy/kong.yml, deploy/kong-check.sh (executable)
- FOUND commits 429c9b4 and 6d14411 in HEAD ancestry
