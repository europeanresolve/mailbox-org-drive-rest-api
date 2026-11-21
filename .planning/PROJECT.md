# mailbox-org-drive-rest-api

## What This Is

A generic, self-hostable REST API that stores JSON records (mirrored to `.xlsx`), serves `.xlsx` sheets as JSON and `.docx` documents as Markdown, all backed by a mailbox.org Drive over WebDAV. It is for small organisations that already keep everything in mailbox.org Drive and cannot maintain a CMS or a separate storage service. The first adopter is a European civil-society non-profit whose website needs forms and Drive-edited content.

## Core Value

Staff keep working in the Drive they already use, and developers get a safe, fast JSON API on top of it.

**Delivery priority:** the write path for website forms (collections + `.xlsx` mirror) ships first; read-only content follows.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Config from file plus environment variables; fail fast with clear errors
- [ ] WebDAV adapter behind a `StorageAdapter` interface: list, stat (ETag, last-modified, size), read, write, create folder; retries with backoff; mount boundaries enforced; path traversal blocked
- [ ] Allow-listed mounts (named folder + `read` / `read-write` mode)
- [ ] Collections: create, list (paginated, filters on indexed fields), get, replace, patch, delete; records validated against the collection's JSON Schema; server-generated UUID plus `createdAt` / `updatedAt`
- [ ] `.xlsx` mirror: debounced, single-writer regeneration after changes; columns derived from schema or mapped in config; atomic writes (upload to temp name, then move)
- [ ] Access policies per collection and per operation: `anonymous` or `apiKey` (hashed keys)
- [ ] Hardened anonymous endpoints: payload size limits, schema validation, rate limits (Kong reference config in `deploy/`, `@fastify/rate-limit` fallback)
- [ ] Sheets: an `.xlsx` worksheet as JSON rows (header row gives field names), cached and refreshed by ETag
- [ ] Documents: `.docx` → Markdown, cached per ETag; embedded images dropped or inlined (config choice)
- [ ] Files: list folders and download files from read mounts
- [ ] HTTP caching: ETag / `Cache-Control` on read endpoints
- [ ] OpenAPI at `/docs`; `/health` and `/ready`
- [ ] Structured logs (pino) with no personal data
- [ ] Local dev stack: Docker Compose with MongoDB and a local WebDAV server; integration tests run against it, never a real Drive
- [ ] CI: lint, typecheck, unit and integration tests, container image build

### Out of Scope

- Organisation-specific content models (newsfeed, research index) — they belong in the consuming apps; this repo stays generic
- Syncing edits made in mirrored `.xlsx` files back into MongoDB — the mirror is one-way and read-only by convention
- A web UI — API only
- Hosting or operating Keycloak or Kong — only reference configs are provided
- OIDC/JWT and role-based policies — next milestone (v2.0)
- `.docx` image extraction to an assets endpoint — next milestone (v2.0)
- GDPR erasure endpoint (5-step procedure, optional OX HTTP API client, erased-ID replay log) — next milestone (v2.0)
- Webhooks / change feed for collections — v2.0
- S3-compatible object API (rclone sidecar vs native subset) — later milestone (v3.0)

## Context

- **Users:** deployers/developers (configure collections, mounts, access; run the service); API consumers (website backend or frontend, internal tools); staff indirectly (open mirrored `.xlsx`, edit content files in Drive; never call the API).
- **Why it needs to exist:** mailbox.org offers WebDAV access to Drive but no REST API, and no existing open-source REST layer for it was found.
- **First-adopter use cases:** (1) website form submissions staff read as spreadsheets — **first priority**; (2) content staff edit in Drive (a spreadsheet of articles plus a `.docx` per article); (3) later, research publications and larger files.
- **Volumes:** writes are tens of records a week per deployment (correctness over throughput). Reads may be one or more per website visit, so the hot path must be served from cache (MongoDB or memory) with no Drive round trip. Drive changes appear within a configurable TTL (default 5 minutes).
- **mailbox.org has no webhooks** — change detection is polling (ETag / PROPFIND on a TTL). No published WebDAV rate limits and no official third-party integration support: low concurrency, exponential backoff on 429/503, no deep PROPFIND traversals on the hot path. Ask mailbox.org support for limits before production use.
- **OX App Suite WebDAV behaviour** (locking, ETag stability, versioning, path encoding of folder names like `Userstore/Last, First`) is unknown and needs a spike early.
- **Drive versioning and trash:** overwriting the mirror adds a new file version and keeps old ones; WebDAV deletes appear to land in the trash. This matters for v2 erasure (delete the mirror, never overwrite it; purge trash and old versions, likely via the OX HTTP API). Spike early alongside WebDAV behaviour.
- **mailbox.org terms (checked 2026-11-21):** nothing on automated access or WebDAV load; misuse clause (Business §6) forbids misuse of infrastructure; provider may terminate with two weeks' notice (Business §7(3)) — so keep an exit path via MongoDB as system of record plus the `StorageAdapter` interface.
- **Data processing:** Heinlein Support GmbH offers an Art. 28 GDPR agreement for mailbox.org; the deployer must confirm it covers Drive on their plan.
- **Open questions for discuss-phase:** collection definitions in config only vs admin endpoints; API keys in config vs MongoDB with rotation endpoints; mirror as one workbook per collection vs one workbook with a sheet per collection; soft delete (tombstone) by default vs hard delete; pnpm vs npm; reference deployment target (single VPS with Docker Compose?).

## Constraints

- **Scope**: Generic and organisation-agnostic — no organisation names, folder layouts or schemas in the repo
- **Repository/licence**: Public repo, EUPL-1.2
- **Tech stack**: TypeScript on Node.js LTS; Fastify (native JSON Schema validation, OpenAPI; revisitable in phase 1); exceljs for `.xlsx`; mammoth (`.docx` → HTML) then turndown (HTML → Markdown) — mammoth's own Markdown output is deprecated; pino logs
- **Storage**: MongoDB is the system of record for collection records; Drive is the source of truth for sheets, documents and files, with MongoDB caching parsed/converted content keyed on ETag / last-modified
- **Portability**: A single container image plus MongoDB; must work without Kong or Keycloak
- **Security**: Least privilege on Drive (dedicated service account recommended); secrets never in the repo; anonymous endpoints hardened
- **Privacy**: Collection records are personal data; no personal data in logs
- **Data in repo**: Planning artefacts and fixtures contain only synthetic data (first adopter's AI tooling policy)
- **Testing**: Integration tests use the local Docker stack, never a real Drive
- **Licensing note**: MongoDB Community is SSPL (self-hosting fine); FerretDB (Apache-2.0) may be tested in CI if a fully OSI-licensed stack matters
- **Trademark**: "mailbox-org" used descriptively only; README states the project is unofficial

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| MongoDB as system of record; `.xlsx` is a one-way mirror from a single background writer | Correctness for writes; staff get spreadsheets without a sync-back problem; exit path if Drive goes away | — Pending |
| Drive is source of truth for read content, cached in MongoDB by ETag | Reads must never hit Drive on the hot path | — Pending |
| `StorageAdapter` interface with WebDAV first | Allows S3 later; exit path from mailbox.org | — Pending |
| Allow-listed mounts with `read` / `read-write` modes | Least privilege on Drive access | — Pending |
| v1 auth: `anonymous` / `apiKey` per collection per operation; OIDC later | Keycloak not deployed until internal forms need it | — Pending |
| Rate limiting at the gateway (Kong reference config) with in-app fallback | Works with or without a gateway | — Pending |
| Fastify as HTTP framework | Native JSON Schema validation and OpenAPI | — Pending (revisit in phase 1) |
| Milestone v1.0 = Foundation + Collections (forms) + Read-only content; v2.0 = OIDC + erasure; v3.0 = object storage | Deliver website forms first; keep later concerns out of the first roadmap | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-11-21 after initialization*
