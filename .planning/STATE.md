---
gsd_state_version: "1.0"
milestone: v1.0
current_phase: 01
current_phase_name: Foundations, OX Spike and Storage Layer
status: executing
stopped_at: Completed 01-10-PLAN.md
last_updated: "2026-11-21T22:00:21.687Z"
last_activity: 2026-11-21
last_activity_desc: Phase 01 execution started
state_head: caf3d98841a185aa0caf694a15284f8b1f8d5903
progress:
  total_phases: 4
  completed_phases: 0
  total_plans: 12
  completed_plans: 11
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-11-21)

**Core value:** Staff keep working in the Drive they already use, and developers get a safe, fast JSON API on top of it.
**Current focus:** Phase 01 — Foundations, OX Spike and Storage Layer

## Current Position

Phase: 01 (Foundations, OX Spike and Storage Layer) — EXECUTING
Plan: 11 of 12
Status: Ready to execute
Last activity: 2026-11-21 — Phase 01 execution started

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: -
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

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

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 1]: OX behaviour is documented in docs/ox-webdav-compatibility.md; its "Consequences" section lists the adapter changes C-1..C-3 that plan 01-12 applies, the ETag/validator input for Phase 4 and the MOVE-vs-PUT input for the Phase 3 mirror
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

Last session: 2026-11-21T22:00:21.645Z
Stopped at: Completed 01-10-PLAN.md
Resume file: None
