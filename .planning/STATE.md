---
gsd_state_version: "1.0"
milestone: v1.0
current_phase: 03
current_phase_name: Mirror Worker
status: executing
stopped_at: Completed 03-01-PLAN.md
last_updated: "2026-11-23T05:15:17.555Z"
last_activity: 2026-11-23
last_activity_desc: Phase 03 execution started
state_head: ba29de61906e98ba36a9fc1f0cc1aa2115de00ce
progress:
  total_phases: 4
  completed_phases: 1
  total_plans: 28
  completed_plans: 21
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-21)

**Core value:** Staff keep working in the Drive they already use, and developers get a safe, fast JSON API on top of it.
**Current focus:** Phase 03 — Mirror Worker

## Current Position

Phase: 03 (Mirror Worker) — EXECUTING
Plan: 2 of 8
Status: Ready to execute
Last activity: 2026-11-23 — Phase 03 execution started

Progress: [███░░░░░░░] 25%

## Performance Metrics

**Velocity:**
- Total plans completed: 8
- Average duration: -
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 02 | 8 | - | - |

**Recent Trend:**
- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 01 P01 | 10min | 2 tasks | 11 files |
| Phase 01 P04 | 5min | 2 tasks | 4 files |
| Phase 01 P11 | 6min | 2 tasks | 7 files |
| Phase 01 P03 | 4min | 3 tasks | 5 files |
| Phase 01 P07 | 5min | 3 tasks | 6 files |
| Phase 01 P06 | 11min | 3 tasks | 7 files |
| Phase 01 P08 | 9min | 3 tasks | 4 files |
| Phase 01 P09 | 5min | 3 tasks | 10 files |
| Phase 01 P05 | 2h | 3 tasks | 3 files |
| Phase 01 P02 | 1h | 3 tasks | 1 files |
| Phase 01 P10 | 12min | 3 tasks | 12 files |
| Phase 01 P12 | 10min | 2 tasks | 5 files |
| Phase 02 P03 | 20min | 2 tasks | 5 files |
| Phase 02 P01 | 9min | 3 tasks | 21 files |
| Phase 02 P02 | 25min | 2 tasks | 10 files |
| Phase 02 P04 | 8min | 2 tasks | 7 files |
| Phase 02 P05 | 14min | 2 tasks | 15 files |
| Phase 02 P06 | 12min | 2 tasks | 8 files |
| Phase 02 P07 | 10min | 1 tasks | 7 files |
| Phase 02 P08 | 25min | 2 tasks | 13 files |
| Phase 03 P01 | 7min | 3 tasks | 27 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: Forms write path (collections, access/hardening, mirror) ships before read-only content; Kong reference config (SEC-09) rides with Phase 2 hardening
- [Roadmap]: FND-05 (container roles api/worker/all) lands in Phase 3, when the worker exists; CI image build is Phase 1
- [Process]: TDD (RED, GREEN, REFACTOR) and trunk-based development on `main`; no phase or milestone branches
- [Phase 01]: [01-01]: Biome ignores **/*.md (pre-existing README/PROJECT-BRIEF fail biome ci formatting)
- [Phase 01]: [01-01]: Plain Fastify logger kept until plan 01-04 PII-free harness
- [Phase 01]: [01-04]: Fastify err serializer cast with 'as never' because typings require message/stack; allow-list omits them
- [Phase 01]: [01-04]: text/plain bodies return 400 (default parser + schema), 415 only for unparsed types like application/xml
- [Phase 01]: [01-11]: Integration helpers use fetch with Basic auth for WebDAV; assertLoopback never echoes the offending URL (may carry credentials)
- [Phase 01]: [01-03]: ResolvedPath implements util.inspect.custom so logging never prints path segments (D-19)
- [Phase 01]: [01-03]: Mount issue order is per-mount (name, root) in config order, then one OVERLAP per pair; AT_ROOT means zero segments after the leading slash
- [Phase 01]: [01-07]: MountView methods are async and write methods check mode before resolving, so a read mount rejects with read-only-mount and zero adapter calls
- [Phase 01]: [01-07]: Contract suite asserts StorageError.kind only; read returns a Buffer capped by maxBytes (25 MiB default), mkdir is strict
- [Phase 01]: [01-06]: Config issues name keys by appending them to the instance path (schema.required at /mongo); env issues name the variable
- [Phase 01]: [01-06]: server.port and server.logLevel are individually optional so defaults and a bare PORT override work
- [Phase 01]: [01-06]: Exact duplicate config issues collapse; missing-key issues sort at the end of their parent object
- [Phase 01]: [01-08]: A Retry-After above the 30 s cap gives rate-limited for any retryable response; a PUT 404 is stat-checked and maps to conflict when the target is a folder (hacdias)
- [Phase 01]: [01-08]: Retried MOVE/DELETE verify with a raw stat inside the held slot, never through run(), so concurrency 1 cannot deadlock
- [Phase 01]: [01-09]: Every DriveHealth state change logs at warn once; SIGTERM/SIGINT handlers live in the main guard so repeated start() calls leave no listeners; a failed startup closes the Mongo client
- [Phase 01]: 01-05: Renovate App install recorded pending (owner browser action); CI, GHCR publish and anonymous pull verified on main
- [Phase 01]: [01-02]: OX spike anon/ record lives outside the repo at ~/.local/state/mailbox-org-drive-rest-api/ox-spike/2026-11-21/anon; OX honours If-Match (412), unlike hacdias, and ETags must be synthesised in fixtures
- [Phase 01]: [01-10]: OX fixtures use synthetic ETags; lastModified null on OX (C-1) and NFD-vs-NFC path folding (C-2) are left for plan 01-12 and pinned by an it.fails replay case
- [Phase 01]: [01-12] Keep NFC fold for OX NFD names (C-2); NFD files stay unreachable via adapter, listed as OX returns them
- [Phase 02]: Kong file-log removes request-carrying fields via custom_fields_by_lua returning nil; kong:3.9.5 pinned (02-03)
- [Phase 02]: allowUnionTypes true in createRecordAjv so nullable fields work under strict mode
- [Phase 02]: INVALID_PROPERTY_NAME checked at every schema depth; RESERVED_PROPERTY at root only
- [Phase 02]: 400 pointers kept only for array indexes into real arrays or schema-declared property names
- [Phase 02]: sibling $ref files must also resolve by realpath inside the config directory
- [Phase 02]: 02-02: createdAt/updatedAt filter values normalised to toISOString form (calendar-checked), not compared as raw strings
- [Phase 02]: 02-02: resolveIndexPath shared by startup checks and the list parser; cursor is strict base64url JSON {s,v,id} validated against sort and field type
- [Phase 02]: 02-04: PATCH write is always filtered on the version it read (If-Match *, lists included); header checked against it first, 3 attempts then 409
- [Phase 02]: 02-04: applyMergePatch defines members as own data properties and reads own members only, so __proto__ stays data
- [Phase 02]: 02-04: malformed, weak or unquoted If-Match parses to an empty version list and gives 412, never last-write-wins
- [Phase 02]: 02-05: the forwarded client is the nearest address not in server.trustProxy (Fastify), not the left-most, so a forged leading X-Forwarded-For entry cannot open a new rate-limit bucket
- [Phase 02]: 02-05: origin guard and rate limiter are separate hooks; a rejected origin spends no slot and a CORS preflight never reaches the limiter
- [Phase 02]: 02-06: 415 media-type hook runs after credentials and the rate limiter, so an unauthenticated caller gets 401, never a media-type hint
- [Phase 02]: 02-06: UNBOUNDED_STRING walks every subschema (incl. $defs); enum/const strings count as bounded
- [Phase 02]: 02-06: real and honeypot anonymous creates share one reply function (anonymousCreated) so status, ETag and body cannot drift
- [Phase 02]: 02-07: Idempotency-Key is handled in the create handler after honeypot and validation, so refusals, 400s and fake 201s write no entry; record id is chosen with the pending entry so stale-lock takeover cannot duplicate
- [Phase 02]: 02-08: OpenAPI paths and components are written from config by transformObject and swagger hides every route; /health and /ready get fixed definitions because the onRoute hook misses routes registered before the plugin loads
- [Phase 02]: 02-08: <name>.record extends the input schema's properties and required instead of allOf, so a closed input schema stays satisfiable; error statuses listed per operation as the code can produce them
- [Phase 03]: 03-01: D-05 mirror config option A; exceljs only in workbook.ts; direct PUT tracer

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 1]: OX behaviour is documented in docs/ox-webdav-compatibility.md; its "Consequences" section holds the ETag/validator input for Phase 4 and the MOVE-vs-PUT input for the Phase 3 mirror; adapter changes C-1..C-3 are applied (plan 01-12); NFD-named files remain unreachable by design (C-2)
- [Phase 1]: Ask mailbox.org support about WebDAV request limits before production use; keep low concurrency and backoff meanwhile
- [Phase 2]: Open decisions for discuss-phase: config-only collections, API keys in config behind `KeyStore`, hard vs soft delete (COLL-06), pnpm vs npm
- [Phase 3]: Mirror workbook layout (one per collection recommended) and atomic-write mechanism depend on the spike; verify exceljs determinism
- [Phase 4]: mammoth tracked-change/comment/hidden-text behaviour and zip-ratio inspection library are unverified

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-11-23T05:15:17.481Z
Stopped at: Completed 03-01-PLAN.md
Resume file: None
