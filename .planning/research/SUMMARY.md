# Project Research Summary

**Project:** mailbox-org-drive-rest-api
**Domain:** Self-hosted REST facade over a WebDAV drive (mailbox.org / OX App Suite) with MongoDB system of record, one-way `.xlsx` mirror, cached sheet/docx reads
**Researched:** 2026-11-21
**Confidence:** MEDIUM (stack HIGH; OX WebDAV behaviour LOW until spiked)

## Executive Summary

This is a form-backend plus spreadsheet-as-backend plus docs-as-CMS product with an unusual constraint: the storage provider (mailbox.org Drive over WebDAV) has no webhooks, no published rate limits, and unverified WebDAV semantics. The proven pattern is ports-and-adapters around the Drive, MongoDB as system of record, and a worker that regenerates the `.xlsx` mirror asynchronously from a durable dirty counter under a Mongo lease. Reads are served from an ETag-validated stale-while-revalidate cache, never from the Drive on the hot path. One Node 26 / Fastify 5 / TypeScript process, one image, MongoDB as the only coordination point (no Redis, no queue).

Recommended approach: ship the forms write path first (collections, access policy, anonymous hardening, mirror), then read-only content (sheets, documents, files). Start with a short OX WebDAV spike, because locks, `If-Match`, ETag stability, MOVE-over-existing, versioning/trash and `Last, First` path encoding are all unknown, and the adapter, mirror and cache designs depend on the answers. The design already avoids relying on conditional writes or locks, so the spike confirms rather than redirects.

Key risks: (1) OX not honouring textbook WebDAV, mitigated by the spike and an adapter contract suite; (2) mirror amplifying writes into Drive versions/quota/rate-limit exposure, mitigated by durable debounce, deterministic output and row-hash skip; (3) anonymous-endpoint abuse and personal data leaking via logs, mitigated by strict validation, layered limits, default-deny policy and a canary-in-logs CI test; (4) untrusted `.xlsx`/`.docx` parsing (zip bombs, `javascript:` links, hidden columns), mitigated by size gates, sanitising and column allow-lists; (5) the unmaintained exceljs, mitigated by confining it behind one module.

## Key Findings

### Recommended Stack

Versions verified against npm and Docker Hub on the research date. Native-compiler TypeScript 7 breaks typescript-eslint, so lint/format is Biome. Node 26 is Active LTS; keep 24 in CI.

**Core technologies:**
- Node 26 (CI also 24), TypeScript 7.0.2, ESM: runtime and language; `tsc --noEmit` in CI, compiled `dist/` in production
- Fastify 5.12.8 + `@fastify/{swagger,swagger-ui,cors,rate-limit,helmet}`: HTTP, OpenAPI, abuse controls
- TypeBox 1.4.7 (static schemas only) + a dedicated strict Ajv 8 (2020-12, no coercion, no stripping, no remote `$ref`) for collection records; never use Fastify's default Ajv for records
- `mongodb` driver 7.9.1 on `mongo:8.0`, string UUID `_id`, keyset pagination, single-document atomic ops only
- `webdav` 5.11.0 behind `StorageAdapter` (strips ETag quotes, so treat ETag as opaque; no retry, so add `p-retry` + `p-limit` at 2-4 concurrency)
- exceljs 4.4.0 pinned exactly and confined to a `workbook/` module; mammoth 1.13.0 + turndown 7.2.5 + gfm plugin; exit path `read-excel-file` / `write-excel-file`
- pino 10 with redaction; `yaml` + TypeBox/Ajv for config; API keys as SHA-256 (or HMAC) of 32 random bytes with `timingSafeEqual`, not argon2
- pnpm 12, vitest 5 with Compose-based integration (Mongo + `hacdias/webdav:v5`), Biome 2.6; `node:26-slim` image

**Critical constraint:** neither dev WebDAV server enforces `If-Match`, so conditional-write behaviour can never be proven in CI. Do not depend on it.

### Expected Features

**Must have (table stakes):**
- Create record with strict schema validation, minimal anonymous response (`id`, `createdAt`), problem+json errors, server-owned id/timestamps
- Anonymous hardening: per-route body limit, required `maxLength`, JSON-only content type, per-collection CORS, rate limit with correct `trustProxy`, honeypot, generic CAPTCHA siteverify hook, optional Idempotency-Key
- `.xlsx` mirror: debounced, single-writer, atomic, formula-safe, one workbook per collection, status and manual rebuild endpoint
- Per-collection per-operation policy (`anonymous` | `apiKey`, default deny), hashed API keys with multiple active keys
- CRUD with cursor pagination and indexed-field equality/range filters only (no query DSL); PATCH as RFC 7396 merge-patch validated post-merge
- Config-defined collections, fail-fast config
- Sheets (column allow-list, hidden sheets/columns skipped), Documents (images drop/inline, hygiene), Files (stream, shallow list), ETag/304 caching, stale-if-error, OpenAPI, `/health`, `/ready`, PII-free logs

**Should have (one cheap differentiator in v1):** manual cache refresh endpoint (`POST /refresh`). Also cheap and fitting: privacy-by-default discipline, generated per-collection OpenAPI, optional `If-Match` on records.

**Defer (v1.x):** signed form token, self-hosted PoW CAPTCHA, urlencoded form POST + redirect, CSV/NDJSON export, retention TTL, batch create, `/metrics`.
**Defer (v2+):** OIDC/roles, webhooks, GDPR erasure, image assets, S3 API, file attachments.
**Never:** admin UI, runtime collection admin endpoints, sync-back from `.xlsx`, per-submission email, third-party spam scoring, query DSL/relations/realtime.

### Architecture Approach

One process, roles `api | worker | all` from day one. Dependency direction is inward: Fastify routes call services, which call repositories and the `StorageAdapter` port. A branded `ResolvedPath` produced only by `PathGuard` makes traversal unrepresentable at call sites. The write request touches only MongoDB and bumps `dirtySeq`. The worker polls `mirror_state`, takes a fenced Mongo lease, regenerates the full workbook, PUTs a temp name and MOVEs over the target (or plain PUT if the spike says so), and commits `mirroredSeq` only if the lease token is still held. A reconciler marks everything dirty on boot and periodically, closing the non-transactional insert/markDirty gap. Reads go through `ContentCache`: stat-by-ETag revalidation on demand, single-flight, SWR with `maxStale`, and converters as pure functions with a `parserVersion` in the served ETag.

**Major components:**
1. Config loader + composition root: frozen typed config, fail fast listing all errors
2. Mounts + PathGuard + StorageAdapter (WebDavAdapter, MemoryAdapter, one shared contract suite): the only WebDAV-aware code, with retry, backoff, concurrency cap and an error taxonomy
3. SchemaRegistry + CollectionService + RecordRepo: strict Ajv compiled once at boot, indexed-filter whitelist, mirror column derivation
4. Auth policy layer: `Principal` + `allow()`, default deny, `KeyStore` interface (config first)
5. MirrorWorker + MirrorState + Lease + Reconciler: durable debounce, fencing token, orphan temp cleanup
6. ContentCache + Converters: SWR, single-flight, size gates, `worker_threads` only if event-loop lag appears

### Critical Pitfalls

1. **WebDAV semantics OX does not honour (locks, If-Match, ETag, MOVE atomicity, version/trash growth).** The Phase 1 spike produces a compatibility matrix and synthetic fixtures. Treat the ETag as an opaque equality token, with fallback to `(lastModified, size)`. Do not rely on locks or conditional writes. Run the adapter contract suite manually against a real test account too.
2. **Mirror write amplification (versions, quota, rate limits) and a fake single-writer.** Use a durable dirty counter, a deterministic workbook (fixed created/modified/creator), a row-hash skip, a request budget in the adapter, a fenced Mongo lease, and a two-instance integration test. Never regenerate per write.
3. **Anonymous endpoint abuse and silent coercion.** Use a dedicated strict Ajv, `additionalProperties:false`, required `maxLength`, a per-route body limit, exact `trustProxy` tested with forged `X-Forwarded-For`, a per-collection ceiling, and a honeypot/challenge hook. Anonymous create returns only `id`/`createdAt`. Warn at startup if list/get is anonymous.
4. **Hostile values in the mirror and PII in logs.** Use an allow-list cell serializer (never pass objects to `cell.value`), strip illegal XML chars, cap cells at 32,767 characters, add a formula-guard prefix, and cap rows. In pino, log the route template rather than the URL, no bodies, and no Mongo/Ajv error values. Add a CI canary test across every error path.
5. **Untrusted office files and path escapes.** Gate on size and zip ratio before parsing. Sanitise mammoth HTML and filter Markdown link schemes. Never enable `externalFileAccess`. Default to a column/sheet allow-list. Use a segment-array `DrivePath` with a traversal corpus and a property test, and enforce mount mode in the adapter wrapper.

## Implications for Roadmap

Four phases, matching coarse granularity and the user's rule that the forms write path ships before read-only content. TDD and trunk-based development apply throughout. The `MemoryAdapter` plus contract suite and the Compose stack are what make test-first practical, so they belong in Phase 1.

### Phase 1: Foundations, OX Spike and Storage Layer
**Rationale:** Everything else depends on config, logging, the Compose/CI stack and a trustworthy storage adapter. The spike results change adapter, mirror and cache decisions, so it goes first.
**Delivers:** fail-fast config (file + env, `*_FILE` secrets); pino with redaction and a canary-test harness; Fastify skeleton with `/health` and `/ready`; Compose stack (Mongo + hacdias/webdav); CI (Biome, tsc, vitest, image build); OX spike write-up and fixtures; `DrivePath`/PathGuard/mounts with a traversal corpus; `StorageAdapter` with Memory and WebDav implementations under one contract suite; retry classification (no retry on 401/403); concurrency cap and request budget; circuit state for `/ready`; exceljs/mammoth interfaces and size-gate stubs.
**Addresses:** config, mounts, health/ready, structured logs, local dev stack, CI.
**Avoids:** Pitfalls 1, 4, 9 (logger), 13, 16, 17. Also records the Mongo portable-subset rule (12) and the 11 interface boundary.

### Phase 2: Collections, Access Policy and Anonymous Hardening
**Rationale:** Anonymous POST is the first public surface, so policy and hardening must land with CRUD, not after. Routes go through the default-deny policy wrapper from the first commit.
**Delivers:** Mongo connection and index bootstrap; SchemaRegistry with strict Ajv; RecordRepo; CollectionService; CRUD routes (cursor pagination, indexed filters, merge-patch validated after merge); problem+json mapper; hashed API keys behind `KeyStore`; per-route body limit; CORS allow-list; rate limit with tested `trustProxy`; honeypot; generic CAPTCHA siteverify hook; Idempotency-Key; per-collection ceiling; generated per-collection OpenAPI. Decide hard vs soft delete here (research recommends hard).
**Addresses:** FEATURES sections A (create side) and B.
**Avoids:** Pitfalls 7, 8, 9 (extended canary), 19.

### Phase 3: Mirror Worker (forms write path complete)
**Rationale:** Depends on Phases 1 and 2. The mirror is the stated reason the project exists, so this closes the first delivery milestone.
**Delivers:** `mirror_state` + `markDirty` wired into CollectionService; fenced lease repo; Reconciler; deterministic workbook builder (explicit frozen column list, flatten rules, allow-list cell serializer, formula guard, row cap); atomic write mechanism chosen by the spike; hash-skip; backoff; orphan temp cleanup; mirror status and rebuild endpoints; mirror lag in `/ready`; `ROLE=api|worker|all`; graceful shutdown releasing the lease.
**Addresses:** `.xlsx` mirror, mirror status/rebuild, write-safety for spreadsheet readers.
**Avoids:** Pitfalls 2, 3, 5, 6, 18, 20 (clock skew via Mongo time, shutdown).

### Phase 4: Read-Only Content and Release Polish
**Rationale:** These are pure additions on the cache primitive. Sheets is the simplest consumer, and Documents and Files follow. Release polish comes last because the caching-headers skeleton exists from Sheets.
**Delivers:** ContentCache (SWR, single-flight, stale-if-error, `maxStale`, parse failure keeps last good, stability window for edits in progress); Sheets (column allow-list, hidden skipped, header normalisation, date policy, cell normaliser); Documents (images drop/inline with cap, sanitiser, link-scheme filter, style map, tracked-change policy); Files (stream, shallow list, `attachment` + `nosniff` + sandbox CSP, size cap); ETag/`Cache-Control`/304 on all reads; manual `POST /refresh`; Kong reference config in `deploy/` (logs method/route/status only); README and ops notes.
**Addresses:** FEATURES section C plus the one v1 differentiator.
**Avoids:** Pitfalls 10, 11 (implementation), 14, 15.

### Phase Ordering Rationale

- Dependency chain: config/adapter, then collections, then mirror. Content reads need only the adapter and cache, so they are independent but deprioritised by user choice.
- Policy and hardening ride with CRUD (Phase 2) because anonymous create is the first public surface.
- The spike lives in Phase 1 because it informs Phase 3 (MOVE vs PUT, version growth) and Phase 4 (ETag stability, revalidation strategy).
- Phase 2 and Phase 1 adapter work can run in parallel if capacity allows. Phase 3 needs both.

### Research Flags

Needs deeper research during planning:
- **Phase 1:** OX/mailbox.org WebDAV behaviour (LOW confidence; the hands-on spike with a throwaway account is the task itself). Also verify TS 7 `erasableSyntaxOnly` / native type stripping and Biome `noFloatingPromises` in the first spike.
- **Phase 3:** the atomic-write mechanism depends on the spike. Verify exceljs determinism (`created`/`modified`) and a LibreOffice-headless fixture check.
- **Phase 4:** mammoth tracked-change/comment/hidden-text behaviour (unverified); the zip-ratio inspection library choice; whether converters need `worker_threads` (decide from measured lag).

Standard patterns (skip research-phase):
- **Phase 2:** Fastify + Ajv + Mongo CRUD, keyed hashing, merge-patch and keyset pagination are well documented. Only the CAPTCHA siteverify details need a quick provider-docs check.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Versions read from registries on the research date; dev WebDAV behaviour tested locally. TS 7, the Biome nursery rule and the pnpm choice are MEDIUM. |
| Features | MEDIUM | Expectations well established; competitor details partly vendor-authored; CAPTCHA APIs and mammoth hygiene unverified. |
| Architecture | MEDIUM-HIGH | Standard patterns; Mongo atomicity and Fastify Ajv defaults verified; OX behaviour and FerretDB compatibility LOW. |
| Pitfalls | MEDIUM | Library/security findings HIGH-MEDIUM; every OX-specific claim is a hypothesis. |

**Overall confidence:** MEDIUM

### Gaps to Address

- OX WebDAV matrix (ETag stability, `If-Match`, LOCK, MOVE overwrite atomicity, chunked PUT, versioning/trash on overwrite and delete, name case sensitivity, quota error codes, path encoding): Phase 1 spike. The adapter contract suite encodes the results. Mirror and cache strategy may change if ETags are unstable.
- mailbox.org request limits: ask support before production. Keep low concurrency and backoff meanwhile.
- Art. 28 agreement coverage of Drive on the adopter's plan: the deployer confirms it, and the README documents it.
- Open decisions to confirm in discuss-phase (research recommendations): config-only collections; API keys in config (hashed, multiple active) behind `KeyStore`; one workbook per collection; hard delete by default; pnpm; single VPS Docker Compose reference deployment.
- FerretDB support: do not claim it. Run it as a non-blocking CI job only if wanted.
- exceljs staleness: record the accepted audit findings (`uuid`, `minimatch` in webdav) and revisit a swap if a real defect appears.
- Distroless Node 26 variant not verified; slim image is the default.

## Sources

### Primary (HIGH confidence)
- npm registry and Docker Hub (versions, Node release schedule), read 2026-11-21
- Local tests of hacdias/webdav, rclone serve webdav and Apache mod_dav (If-Match, ETag, MOVE), 2026-11-21
- Fastify validation docs (default Ajv options); `webdav` package source (ETag stripping)
- exceljs and mammoth READMEs (cell shapes, image handling, security warnings)
- mailbox.org Linux guide (davfs2 `if_match_bug`, `use_locks 0`); PROJECT.md terms review

### Secondary (MEDIUM confidence)
- Basin, SheetDB, PocketBase/Directus documentation summaries; IETF Idempotency-Key draft (rev 07)
- Snyk/NVD for mammoth CVEs (CVE-2025-11849; prototype pollution fixed in 1.12.2)
- RFC 4918, RFC 5861, RFC 7396, RFC 9457 applied from general knowledge

### Tertiary (LOW confidence)
- OX-specific behaviour (forum reports, inference), FerretDB compatibility, ALTCHA maturity: validate during the spike or phase

---
*Research completed: 2026-11-21*
*Ready for roadmap: yes*
