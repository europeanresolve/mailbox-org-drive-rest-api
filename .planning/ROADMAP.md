# Roadmap: mailbox-org-drive-rest-api

## Overview

Milestone v1.0 takes the project from an empty repository to a self-hostable REST API over a mailbox.org Drive. Delivery order follows the stated priority: the website-forms write path ships first, read-only content follows. Phase 1 lays the foundations (local stack, CI, config, logging) and a trustworthy storage layer, and runs the OX WebDAV spike whose findings shape the mirror and cache designs. Phase 2 delivers collections with default-deny access policy and hardened anonymous endpoints, since anonymous create is the first public surface. Phase 3 adds the single-writer `.xlsx` mirror that staff open in Drive, which completes the forms write path. Phase 4 serves Drive-edited sheets, `.docx` documents and files from an ETag-validated cache. All behaviour is built test-first (RED, GREEN, REFACTOR) and lands on trunk-based `main`, which stays green and releasable. v2.0 (OIDC, GDPR erasure, image assets, webhooks) and v3.0 (object storage) are out of this roadmap.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Foundations, OX Spike and Storage Layer** - Local stack, CI, fail-fast config, PII-free logs, WebDAV compatibility matrix, and a path-safe StorageAdapter
- [ ] **Phase 2: Collections, Access Policy and Anonymous Hardening** - Config-defined collections with strict validation, CRUD, default-deny policy, API keys, and abuse-resistant anonymous form submission
- [ ] **Phase 3: Mirror Worker** - Debounced, single-writer, formula-safe `.xlsx` mirror per collection with recovery and operator status
- [ ] **Phase 4: Read-only Content** - Sheets as JSON, `.docx` as Markdown and file downloads from an ETag-validated cache with stale-if-error

## Phase Details

### Phase 1: Foundations, OX Spike and Storage Layer
**Goal**: A developer can start the local stack, run the full test suite green in CI, and rely on a path-safe, retry-aware storage layer whose behaviour against mailbox.org is documented.
**Mode:** mvp
**Depends on**: Nothing (first phase)
**Requirements**: FND-01, FND-02, FND-03, DEV-01, DEV-02, DEV-03, DEV-04, STOR-01, STOR-02, STOR-03, STOR-04, STOR-05
**Success Criteria** (what must be TRUE):
  1. Developer starts MongoDB plus a local WebDAV server with one command and runs unit and integration tests against it, with no test touching a real Drive and all fixtures and examples containing only synthetic data; every push to `main` then runs lint/format, typecheck, unit and integration tests and a container image build, and a failure in any step fails the pipeline
  2. Deployer who starts the service with an invalid config (file plus environment, secrets also via `*_FILE`) gets one startup failure listing every config error; with a valid config, `/health` answers while the process is alive and `/ready` fails when MongoDB is down but only reports (does not fail on) a Drive outage; and the structured pino logs use route templates and carry no bodies or personal data, proven by a CI canary-string test across the error paths that exist in this phase (the harness is extended as later phases add error paths)
  3. Team can read a written OX App Suite / mailbox.org WebDAV compatibility matrix (ETag stability, If-Match, LOCK, MOVE-over-existing, versioning and trash on overwrite and delete, path encoding of names like `Last, First`) backed by synthetic fixtures
  4. Deployer can allow-list mounts with `read` or `read-write` mode: a path outside a mount or a write to a `read` mount is rejected, and a traversal corpus (`..`, encoded separators, Unicode normalisation) cannot escape a mount
  5. The WebDAV and in-memory `StorageAdapter` implementations both pass one shared contract suite (list, stat, read, write, create folder, move, delete), and the WebDAV adapter retries 429/503/network failures with exponential backoff, never retries 401/403, caps concurrency, and never issues deep PROPFIND traversals
**Plans:** 12/12 plans executed

Plans (listed in wave order):
- [x] 01-01-PLAN.md — Walking skeleton, part 1: package legitimacy gate, toolchain, `/health` from the container image (wave 1)
- [x] 01-11-PLAN.md — Walking skeleton, part 2: Compose stack, integration project, MongoDB and WebDAV round trips (wave 2)
- [x] 01-02-PLAN.md — OX spike: probe script in gitignored `tmp/spike/`, local dry run, human-run probe against mailbox.org (wave 2)
- [x] 01-03-PLAN.md — Path safety: `DrivePath`, `Mounts`, branded `ResolvedPath`, traversal corpus (wave 2)
- [x] 01-04-PLAN.md — PII-free logging harness and HTTP canary test (wave 2)
- [x] 01-05-PLAN.md — CI pipeline, GHCR publish, Renovate, README quick start (wave 3)
- [x] 01-06-PLAN.md — Fail-fast YAML config loader and config-aware startup (wave 3)
- [x] 01-07-PLAN.md — `StorageAdapter` port, `MemoryAdapter`, shared contract suite, `MountView` (wave 3)
- [x] 01-08-PLAN.md — `WebDavAdapter`: retry, cooldown, concurrency cap, Depth rules, contract on Compose (wave 4)
- [x] 01-09-PLAN.md — `/ready`, Drive health, composition root, end-to-end canary sweep (wave 5)
- [x] 01-10-PLAN.md — OX compatibility matrix, fixtures, replay tests, synthetic-data guard (wave 5)
- [x] 01-12-PLAN.md — Adapter and path-rule adjustments from the matrix's Consequences (wave 6)

### Phase 2: Collections, Access Policy and Anonymous Hardening
**Goal**: A website can safely submit forms to anonymous create endpoints, and deployers can manage records through API-key-protected CRUD, all defined in config with default-deny access.
**Mode:** mvp
**Depends on**: Phase 1
**Requirements**: COLL-01, COLL-02, COLL-03, COLL-04, COLL-05, COLL-06, COLL-07, COLL-08, SEC-01, SEC-02, SEC-03, SEC-04, SEC-05, SEC-06, SEC-07, SEC-08, SEC-09, FND-04
**Success Criteria** (what must be TRUE):
  1. Deployer defines a collection in config (JSON Schema, indexed fields, per-operation policies), startup rejects an invalid definition, and API consumer can open an OpenAPI 3.1 document and UI at `/docs` that includes per-collection schemas generated from that config
  2. A website form POST creates a record: a valid payload gets a server-generated UUID, `createdAt` and `updatedAt` (anonymous callers receive only `id` and `createdAt`); a wrong type, extra property or over-long string is rejected, never coerced or stripped, with an `application/problem+json` error that does not echo submitted values; a filled honeypot field is silently discarded; a failed CAPTCHA verification is rejected; a retry with the same `Idempotency-Key` returns the original result and creates no duplicate
  3. API consumer can get a record by ID, list records with cursor pagination and equality/range filters on indexed fields only (a filter on a non-indexed field is rejected), replace a record (PUT), merge-patch it (RFC 7396, validated after merge), and delete it
  4. Every collection operation is denied unless set to `anonymous` or `apiKey`; a request with a missing or wrong API key is rejected; keys are stored hashed and compared in constant time, and two keys can be active at once so one can be rotated out without downtime
  5. Anonymous endpoints reject an oversized body, a non-`application/json` content type, and a browser request from an origin not allowed for that collection; the per-IP rate limit still holds when a client forges `X-Forwarded-For`; and the repository provides a Kong reference config in `deploy/` that rate-limits and logs only method, route and status
**Plans:** 8 plans

Plans (listed in wave order):
- [ ] 02-01-PLAN.md — Tracer: package legitimacy gate, one config collection, anonymous POST and API-key GET with strict validation, key hashing and keygen (wave 1)
- [ ] 02-03-PLAN.md — Kong reference config with behavioural check, README gateway section, SEC-07 dropped per D-07 (wave 1)
- [ ] 02-02-PLAN.md — List with cursor paging, filters and sort on indexed fields only, index creation (wave 2)
- [ ] 02-04-PLAN.md — PUT, RFC 7396 merge-patch validated after merge, DELETE, If-Match (wave 3)
- [ ] 02-05-PLAN.md — Per-collection CORS and per-IP rate limit that resists forged X-Forwarded-For (wave 4)
- [ ] 02-06-PLAN.md — Body size limit, JSON-only content type, honeypot (wave 5)
- [ ] 02-07-PLAN.md — Idempotency-Key on create (wave 6)
- [ ] 02-08-PLAN.md — OpenAPI 3.1 at `/docs` from config, example config, README, end-to-end canary sweep (wave 6)

### Phase 3: Mirror Worker
**Goal**: Staff open an always-current `.xlsx` per collection in their Drive, written safely by a single background writer, without anyone calling the API.
**Mode:** mvp
**Depends on**: Phase 1, Phase 2
**Requirements**: MIRR-01, MIRR-02, MIRR-03, MIRR-04, MIRR-05, MIRR-06, MIRR-07, MIRR-08, FND-05
**Success Criteria** (what must be TRUE):
  1. After records are created, changed or deleted, each collection's own `.xlsx` appears and is regenerated in Drive after a debounce window (a burst of writes yields far fewer uploads than writes), with columns following the schema or a config mapping in a stable order
  2. Attacker-supplied values (leading `=`, `+`, `-`, `@`, tab, illegal XML characters, values over the cell length cap) open in a spreadsheet as plain, typed text and never as formulas or links
  3. With two instances running, a two-instance integration test shows only one writes the mirror at a time; each write is atomic as far as the spike showed Drive allows (temp upload then move, or the chosen fallback) and orphan temp files are cleaned up; and an unchanged collection is not re-uploaded
  4. After a crash between a record write and its mirror update, the mirror catches up automatically through the boot-time and periodic reconciler, with no manual step
  5. Operator with an API key can read mirror status (last mirrored, lag, last error) and trigger a full rebuild from MongoDB, and Deployer can run the single container image as role `api`, `worker` or `all` needing only MongoDB (no Kong or Keycloak)
**Plans**: TBD

### Phase 4: Read-only Content
**Goal**: API consumers read Drive-edited spreadsheets, Word documents and files as fast, cached JSON and Markdown, while staff keep working in Drive.
**Mode:** mvp
**Depends on**: Phase 3 (delivery priority: the forms write path ships first; technically needs only Phases 1 and 2)
**Requirements**: READ-01, READ-02, READ-03, READ-04, READ-05, READ-06, READ-07, READ-08, READ-09, READ-10, READ-11
**Success Criteria** (what must be TRUE):
  1. API consumer can read an `.xlsx` worksheet from a read mount as JSON rows with field names from the header row, and hidden sheets, hidden columns and unconfigured columns never appear in the response
  2. API consumer can read a `.docx` from a read mount as sanitised Markdown (no `javascript:` or other unsafe link schemes), and Deployer can choose per config whether embedded images are dropped or inlined up to a size cap
  3. API consumer can list a folder (shallow) and download files from read mounts, and downloads arrive as attachments with `nosniff`
  4. Repeated reads of a sheet or document are served from the MongoDB cache with no Drive round trip until the TTL (default 5 minutes) expires; many concurrent requests for an expired entry cause one Drive refresh; every read returns `ETag` and `Cache-Control` and answers a matching conditional request with `304`; and when Drive is down or a file fails to parse, the last good version is still served
  5. An `.xlsx` or `.docx` over the size or compression-ratio limit is rejected before parsing, and an Operator with an API key can force a cache refresh for a sheet or document
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundations, OX Spike and Storage Layer | 12/12 | In Progress | - |
| 2. Collections, Access Policy and Anonymous Hardening | 0/TBD | Not started | - |
| 3. Mirror Worker | 0/TBD | Not started | - |
| 4. Read-only Content | 0/TBD | Not started | - |
