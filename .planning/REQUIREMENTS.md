# Requirements: mailbox-org-drive-rest-api

**Defined:** 2026-11-21
**Core Value:** Staff keep working in the Drive they already use, and developers get a safe, fast JSON API on top of it.

Milestone **v1.0**: Foundation + Collections (website forms, shipped first) + Read-only content. All behaviour is built test-first (TDD) on a trunk-based `main`.

## v1 Requirements

### Foundation & Operations

- [x] **FND-01**: Deployer can configure the service from a config file plus environment variables (secrets also via `*_FILE`), and startup fails fast listing every config error
- [x] **FND-02**: Operator can call `/health` (process alive) and `/ready` (MongoDB reachable; Drive outage reported but does not fail readiness)
- [x] **FND-03**: Operator gets structured pino logs that contain no personal data (route templates not raw URLs, no bodies, no Mongo/Ajv error values), enforced by a CI canary-string test across error paths
- [x] **FND-04**: API consumer can read an OpenAPI 3.1 document and UI at `/docs`, including per-collection schemas generated from config
- [x] **FND-05**: Deployer can run the service as a single container image with roles `api`, `worker` or `all`, needing only MongoDB (no Kong or Keycloak)

### Developer Experience

- [x] **DEV-01**: Developer can start a local stack (Docker Compose: MongoDB + local WebDAV server) with one command
- [x] **DEV-02**: Developer can run unit tests and integration tests against the local stack; no test touches a real Drive
- [x] **DEV-03**: Every push to `main` runs CI: lint/format, typecheck, unit and integration tests, container image build
- [x] **DEV-04**: Planning artefacts, fixtures and examples contain only synthetic data

### Storage

- [x] **STOR-01**: Team has a written OX App Suite / mailbox.org WebDAV compatibility matrix (ETag stability, If-Match, LOCK, MOVE-over-existing, versioning and trash on overwrite/delete, path encoding of names like `Last, First`) with synthetic fixtures, produced by a spike
- [x] **STOR-02**: Deployer can allow-list mounts (named Drive folder plus `read` or `read-write` mode); any path outside a mount, or a write to a `read` mount, is rejected
- [x] **STOR-03**: Path traversal and encoding tricks (`..`, encoded separators, Unicode normalisation) cannot escape a mount, verified by a traversal corpus test
- [x] **STOR-04**: Storage access goes through a `StorageAdapter` interface (list, stat with ETag/last-modified/size, read, write, create folder, move, delete) with a WebDAV and an in-memory implementation passing one shared contract suite
- [x] **STOR-05**: The WebDAV adapter retries transient failures (429/503/network) with exponential backoff, never retries 401/403, caps concurrency, and never issues deep PROPFIND traversals

### Collections

- [x] **COLL-01**: Deployer can define collections in config, each with a JSON Schema, indexed fields and per-operation policies
- [x] **COLL-02**: API consumer can create a record; it is validated by a strict validator (no type coercion, no silent stripping, `additionalProperties:false`) and gets a server-generated UUID, `createdAt` and `updatedAt`
- [x] **COLL-03**: API consumer can list records with cursor pagination and equality/range filters on indexed fields only
- [x] **COLL-04**: API consumer can get a single record by ID
- [x] **COLL-05**: API consumer can replace a record (PUT) and patch it (RFC 7396 merge-patch, validated after merge)
- [x] **COLL-06**: API consumer can delete a record (hard vs soft delete decided in discuss-phase)
- [x] **COLL-07**: API consumer receives errors as `application/problem+json` without echoing submitted values
- [x] **COLL-08**: Anonymous create responds with only `id` and `createdAt`

### Access & Hardening

- [x] **SEC-01**: Deployer can set each collection operation to `anonymous` or `apiKey`; anything unset is denied
- [x] **SEC-02**: API consumer can authenticate with an API key; keys are stored hashed, compared in constant time, and several can be active at once for rotation
- [x] **SEC-03**: Anonymous endpoints enforce a per-route body size limit, required `maxLength` on strings, and `Content-Type: application/json`
- [x] **SEC-04**: Deployer can set allowed CORS origins per collection; browser requests from other origins are rejected
- [x] **SEC-05**: Anonymous endpoints are rate limited per client IP in-app, with `trustProxy` configured so forged `X-Forwarded-For` cannot bypass it
- [x] **SEC-06**: Form submissions with a filled honeypot field are silently discarded
- [x] **SEC-08**: API consumer can send an `Idempotency-Key` on create; retries with the same key return the original result instead of a duplicate record
- [x] **SEC-09**: Repository provides a Kong reference gateway config in `deploy/` (rate limiting, logging of method/route/status only)

### Spreadsheet Mirror

- [x] **MIRR-01**: Staff see each collection mirrored to its own `.xlsx` in Drive, regenerated (debounced) after record changes
- [x] **MIRR-02**: Only one writer updates a mirror at a time, even with several replicas (Mongo lease with fencing), verified by a two-instance test
- [x] **MIRR-03**: Mirror writes use a direct PUT over the final file, per the spike (P-17); no temp files are created
- [x] **MIRR-04**: Mirror columns follow the schema, in a stable order
- [x] **MIRR-05**: Attacker-supplied values can never become formulas or links in the mirror (explicit cell types, formula-prefix guard, illegal XML characters stripped, cell length capped)
- [x] **MIRR-06**: The mirror is not re-uploaded when its content has not changed (deterministic workbook plus content hash)
- [x] **MIRR-07**: A missed mirror update (crash between write and mirror) is recovered automatically by a reconciler on boot and periodically
- [x] **MIRR-08**: Operator (apiKey) can read mirror status (last mirrored, lag, last error) and trigger a full rebuild from MongoDB

### Read-only Content

- [ ] **READ-01**: API consumer can read an `.xlsx` worksheet from a read mount as JSON rows, with field names from the header row
- [ ] **READ-02**: Sheet responses expose only configured columns and named sheets (hidden sheets and columns never leak)
- [ ] **READ-03**: API consumer can read a `.docx` from a read mount as Markdown (mammoth → turndown), sanitised (no `javascript:` or other unsafe link schemes)
- [ ] **READ-04**: Deployer can choose per config whether embedded `.docx` images are dropped or inlined (with a size cap)
- [ ] **READ-05**: API consumer can list a folder (shallow) and download files from read mounts; downloads are served as attachments with `nosniff`
- [ ] **READ-06**: Sheets and documents are served from a MongoDB cache keyed on ETag/last-modified, refreshed after a configurable TTL (default 5 minutes) without a Drive round trip on the hot path
- [ ] **READ-07**: When Drive is unavailable or a file fails to parse, the last good cached version is still served (stale-if-error)
- [ ] **READ-08**: Concurrent requests for an expired entry trigger one Drive refresh, not many (single-flight)
- [ ] **READ-09**: Read endpoints return `ETag` and `Cache-Control` and answer conditional requests with `304`
- [ ] **READ-10**: Untrusted `.xlsx`/`.docx` are rejected before parsing when over a size or compression-ratio limit
- [ ] **READ-11**: Operator (apiKey) can force a cache refresh for a sheet or document

## v2 Requirements

Deferred to later milestones. Tracked but not in the current roadmap.

### Identity (v2.0)

- **IDNT-01**: Validate OIDC/JWT access tokens (Keycloak or any provider)
- **IDNT-02**: Map role claims to per-operation policies

### Privacy (v2.0)

- **PRIV-01**: GDPR erasure endpoint implementing the 5-step procedure (hard delete in Mongo, delete mirror file, purge trash and old versions, regenerate mirror, log erased ID)
- **PRIV-02**: Optional OX HTTP API client to purge trash and file versions
- **PRIV-03**: Erased-ID list replayed after a backup restore

### Content (v2.0)

- **CONT-01**: Extract `.docx` images into a served assets endpoint

### Integration (v2.0)

- **INTG-01**: Webhooks or change feed for collections

### Object Storage (v3.0)

- **OBJ-01**: S3-compatible object API (rclone sidecar vs native subset, decided then)

### Nice-to-have (v1.x)

- **NICE-01**: Signed form token / self-hosted proof-of-work CAPTCHA
- **NICE-02**: `application/x-www-form-urlencoded` form POST with redirect
- **NICE-03**: CSV/NDJSON export of a collection
- **NICE-04**: Per-collection retention TTL
- **NICE-05**: `/metrics` endpoint
- **NICE-06**: `If-Match` optimistic concurrency on record updates

## Out of Scope

| Feature | Reason |
|---------|--------|
| Organisation-specific content models (newsfeed, research index) | Belongs in consuming apps; repo stays generic |
| Sync-back from mirrored `.xlsx` into MongoDB | Mirror is one-way; MongoDB is system of record |
| Web UI / admin UI | API only |
| Runtime collection admin endpoints | Collections are config-defined (confirm in discuss-phase) |
| Hosting/operating Keycloak or Kong | Only reference configs are provided |
| Per-submission email notifications | Not core; adds PII flow and mail infra |
| Third-party spam scoring (e.g. Akismet) | Sends personal data to third parties |
| Multipart file attachments on records | Large attack surface; object storage is v3.0 |
| Query DSL, relations, realtime, full-text search | Beyond scope for tens of writes a week |
| Relying on WebDAV locks or `If-Match` conditional writes | Unverified on OX and unenforced by dev servers |
| CAPTCHA verification inside the API (SEC-07) | Dropped in Phase 2 discussion (D-07): CAPTCHA is the caller's job; anonymous endpoints rely on honeypot, rate limit, CORS and the gateway |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| FND-01 | Phase 1 | Complete |
| FND-02 | Phase 1 | Complete |
| FND-03 | Phase 1 | Complete |
| FND-04 | Phase 2 | Complete |
| FND-05 | Phase 3 | Complete |
| DEV-01 | Phase 1 | Complete |
| DEV-02 | Phase 1 | Complete |
| DEV-03 | Phase 1 | Complete |
| DEV-04 | Phase 1 | Complete |
| STOR-01 | Phase 1 | Complete |
| STOR-02 | Phase 1 | Complete |
| STOR-03 | Phase 1 | Complete |
| STOR-04 | Phase 1 | Complete |
| STOR-05 | Phase 1 | Complete |
| COLL-01 | Phase 2 | Complete |
| COLL-02 | Phase 2 | Complete |
| COLL-03 | Phase 2 | Complete |
| COLL-04 | Phase 2 | Complete |
| COLL-05 | Phase 2 | Complete |
| COLL-06 | Phase 2 | Complete |
| COLL-07 | Phase 2 | Complete |
| COLL-08 | Phase 2 | Complete |
| SEC-01 | Phase 2 | Complete |
| SEC-02 | Phase 2 | Complete |
| SEC-03 | Phase 2 | Complete |
| SEC-04 | Phase 2 | Complete |
| SEC-05 | Phase 2 | Complete |
| SEC-06 | Phase 2 | Complete |
| SEC-07 | Phase 2 | Dropped |
| SEC-08 | Phase 2 | Complete |
| SEC-09 | Phase 2 | Complete |
| MIRR-01 | Phase 3 | Complete |
| MIRR-02 | Phase 3 | Complete |
| MIRR-03 | Phase 3 | Complete |
| MIRR-04 | Phase 3 | Complete |
| MIRR-05 | Phase 3 | Complete |
| MIRR-06 | Phase 3 | Complete |
| MIRR-07 | Phase 3 | Complete |
| MIRR-08 | Phase 3 | Complete |
| READ-01 | Phase 4 | Pending |
| READ-02 | Phase 4 | Pending |
| READ-03 | Phase 4 | Pending |
| READ-04 | Phase 4 | Pending |
| READ-05 | Phase 4 | Pending |
| READ-06 | Phase 4 | Pending |
| READ-07 | Phase 4 | Pending |
| READ-08 | Phase 4 | Pending |
| READ-09 | Phase 4 | Pending |
| READ-10 | Phase 4 | Pending |
| READ-11 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 49 total
- Mapped to phases: 49
- Unmapped: 0

---
*Requirements defined: 2026-11-21*
*Last updated: 2026-11-21 after roadmap creation (traceability filled; coverage corrected from 48 to 50)*
*Last updated: 2026-11-22 after Phase 2 plan 02-03: SEC-07 (CAPTCHA siteverify) dropped per D-07, moved to Out of Scope; coverage 50 to 49*
*Last updated: 2026-11-23 after Phase 3 plan 03-01: MIRR-03/MIRR-04 reworded for direct PUT and schema column order (D-02, D-08)*
