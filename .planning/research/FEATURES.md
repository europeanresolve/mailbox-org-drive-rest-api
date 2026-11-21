# Feature Landscape

**Domain:** Self-hostable REST API over cloud-drive storage (mailbox.org Drive via WebDAV): form-submission collections with `.xlsx` mirror (priority 1), `.xlsx` sheets as JSON, `.docx` as Markdown, file listing/download (priority 2)
**Researched:** 2026-11-21
**Overall confidence:** MEDIUM (feature expectations are well established; competitor specifics came from vendor docs and comparison blogs, partly competitor-authored, and were not cross-verified)

## Reference Landscape (what comparable systems do)

No single product covers this combination. The closest comparators each cover one slice:

| Slice | Comparators | What they teach |
|-------|-------------|-----------------|
| Form-submission backend | Formspree, Basin, Getform | The write path is mostly about abuse control: honeypot, CAPTCHA (hCaptcha / reCAPTCHA / Turnstile), allowed-domain restriction, custom spam rules, webhooks, email notification, file upload. Basin documents honeypot + filters + three CAPTCHA providers + domain restriction + multiple webhooks. Formspree specifics not verified this session. |
| Spreadsheet-as-backend | SheetDB, Sheety, Sheet.best | Sheet rows become JSON, CRUD via REST, API keys, CORS origin restriction, IP allow-list, caching, per-IP rate limits (SheetDB documents 30 requests / 10 s per IP). They are rate-limited by the upstream (Google Sheets quota), which is why they sell caching. Same upstream-quota problem applies here (WebDAV, unpublished limits). |
| Schema-driven headless backends | PocketBase, Directus, NocoDB, Baserow | Per-collection access rules, filter/sort/pagination query params, OpenAPI, admin UI, realtime, relations, webhooks, file fields. Most of this is deliberately out of scope here (no UI, no relations, no realtime). Take only: per-collection per-operation rules, simple filtering, generated OpenAPI. |
| Docs-as-CMS | Google-Docs/Notion-as-CMS wrappers, static-site "source" plugins | Doc to Markdown/HTML, metadata (title, modified), draft/published gating, cache and rebuild-on-demand. Pain points are always: leaking drafts, formatting drift, stale cache after an edit. |

Differentiating position of this project: data stays in the organisation's own EU Drive, staff never leave Drive and spreadsheets, self-hosted, no per-request pricing, MongoDB as exit path.

## Table Stakes

Features users expect. Missing means the product feels unsafe or incomplete for its stated first use case.

### A. Form-submission write path (priority 1)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Create record via `POST /collections/{name}/records`, JSON body, schema-validated | Core function of every form backend | Low | Fastify native JSON Schema (Ajv). Set `additionalProperties: false` by default so unknown fields are rejected, not stored. |
| Anonymous create returns minimal response (`id`, `createdAt`) only | Anonymous writers must not learn about other records or echo-attack | Low | `201 Created`; never return stored personal data to anonymous callers beyond what they sent. |
| Field-level validation errors in a stable error format | Frontends must show "email invalid" next to the field | Low | RFC 9457 `application/problem+json` with an `errors[]` array (field path, message). Do not leak schema internals beyond that. |
| Hard payload size limit + string `maxLength` enforcement | Anonymous endpoint is a free storage and DoS target | Low | Fastify `bodyLimit` per route (small default, e.g. 16 KB for forms); require `maxLength` on string fields in collection schemas or apply a default. Reject unknown `Content-Type` with 415. |
| Require `Content-Type: application/json` on anonymous writes | Non-JSON types are "simple" cross-origin requests that skip CORS preflight; JSON forces a preflight for browsers | Low | Free, mild protection. Also the reason plain HTML-form (urlencoded) POST is a deliberate non-default, see Differentiators. |
| Per-collection CORS allowed origins | Browser forms on the org's site call the API cross-origin | Low | Not a security boundary (non-browser clients ignore it); document that clearly. Also reject browser requests with a non-matching `Origin` header (cheap, reduces drive-by abuse). |
| Rate limiting on anonymous endpoints (per IP, correct behind proxy) | Every serious form backend has it | Low-Med | Gateway-level (Kong reference) with `@fastify/rate-limit` fallback. Needs correct `trustProxy` handling or all clients share one IP. Do not persist IPs in records. |
| Honeypot field (silent discard) | Cheapest spam filter; Basin, Formspree, and everyone else offer it | Low | Per-collection config: honeypot field name. If non-empty, return the same `201` shape but store nothing (bots must not learn they were caught). Field must never reach the schema, record or mirror. |
| CAPTCHA verification hook | Honeypot alone fails against targeted bots; EU non-profit sites commonly need a CAPTCHA | Med | Turnstile, hCaptcha and reCAPTCHA all use the same server-side "siteverify" pattern (POST secret + token, JSON `success`), so ship one generic verifier with a configurable URL and secret rather than three integrations. Token field is stripped before validation and never stored. Per-collection on/off. (From knowledge of those APIs, not re-verified this session; confirm against provider docs in the phase.) |
| Idempotency-Key support on `POST` create | Double-clicks and client retries otherwise create duplicate rows staff then read in the spreadsheet | Med | `Idempotency-Key` header (Stripe-style; the IETF `draft-ietf-httpapi-idempotency-key-header` reached revision 07 in Oct 2025 and its expiry date has passed, so treat as de-facto convention, not a standard). Store key + request hash + response in MongoDB with TTL (24 h). Same key + same payload returns the original `201`; same key + different payload returns `422`/`409`. Optional header, not required. |
| Server-generated UUID, `createdAt`, `updatedAt`; client cannot set them | Prevents ID collisions and tampering | Low | Already in PROJECT.md. Strip or reject client-supplied values. |
| `.xlsx` mirror of every collection, debounced, single writer, atomic (temp name then move) | This is the stated reason the project exists: staff read form submissions as a spreadsheet | High | One-way. Header row from schema (titles) or config mapping; stable column order; `id`, `createdAt` columns first. Debounce window configurable (default tens of seconds, not per-write). Single writer needs a lock (Mongo-based lease) if more than one replica runs. Failure to upload must retry and must not block the write path (write acknowledged once in MongoDB). |
| Mirror write-safety for spreadsheet readers | Submissions are attacker-controlled text that staff open in Excel/LibreOffice | Low | Write all values as explicit string/number/date cell types (never formulas). Defence in depth: prefix a leading `=`, `+`, `-`, `@` with an apostrophe-style guard in the mirror (and in any future CSV export) to avoid formula-injection when a human edits or re-saves a cell. |
| Mirror status and manual rebuild | A mirror that silently lags or corrupts is worse than none; rebuild-from-Mongo is also the recovery path | Low-Med | `GET /collections/{name}/mirror` (last success, last error, pending count) and `POST .../mirror/rebuild`, both apiKey-only. |

### B. Collection management and auth (needed to operate priority 1)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Per-collection, per-operation access policy: `anonymous` or `apiKey` | Standard in PocketBase/Directus rule models; here a simplified form | Low-Med | Safe default for every operation is `apiKey`; `anonymous` must be explicitly set. Typical form: `create: anonymous`, everything else `apiKey`. |
| Hashed API keys, constant-time compare, multiple active keys for rotation | Keys are credentials; rotation without downtime is expected | Low-Med | Store only hash (SHA-256 of a high-entropy key is sufficient; not passwords). Key to collection/operation scoping. Decision pending: config vs MongoDB storage. |
| Collection definitions in versioned config files, schema validated at startup (fail fast) | Reproducible deployments; avoids needing an admin UI | Low-Med | Includes JSON Schema, mirror mapping, access, CORS, limits, honeypot, CAPTCHA. |
| List records: pagination, filter on indexed fields, sort | Staff tools and website admin pages need to read | Med | Cursor pagination on `(createdAt, id)` preferred over offset; simple `?field=value` equality (plus `from`/`to` on `createdAt`) only, no query DSL. Only fields declared `indexed` in the collection config are filterable (prevents unindexed scans and operator injection: never pass raw query objects into Mongo). |
| Get / replace / patch / delete record (apiKey) | CRUD completeness | Low-Med | PATCH as JSON Merge Patch (RFC 7396), re-validated against the schema after merge. Updates and deletes trigger a mirror regeneration. |

### C. Read-only content (priority 2)

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Sheet endpoint: configured worksheet as JSON rows, header row = field names | Core function of SheetDB/Sheety | Med | Config-addressed only (named sheet resource maps to mount + file + worksheet), not arbitrary path access. Normalise header names; reject or suffix duplicate headers; skip fully empty rows; formulas return cached computed values; dates as ISO 8601 (handle 1900/1904 date systems); optional per-column type hints (string / number / boolean / date). |
| Sheet column allow-list (and hidden sheet/column/row handling) | Staff add internal-notes columns and hidden sheets; an anonymous endpoint would publish them | Low-Med | Expose only configured columns; never expose hidden worksheets; decide explicitly what to do with hidden rows/columns (recommend: skip hidden rows, ignore hidden-ness for columns only if listed). Biggest data-leak risk in the read path. |
| Sheet pagination, field selection, simple equality filters | Articles sheet may grow; sites want `?status=published` | Low-Med | In-memory over the cached parsed sheet (or Mongo). Same no-DSL rule as collections. |
| Document endpoint: `.docx` as Markdown (headings, emphasis, lists, links, tables) | Core function of docs-as-CMS tools | Med | mammoth (docx to HTML) then turndown with GFM tables plugin, cached per ETag. Add a configurable mammoth style map for custom Word styles. |
| Document images: drop or inline (config) | Images otherwise silently vanish or bloat payloads | Low | Already decided; extraction to an assets endpoint is v2. |
| Document hygiene: tracked changes, comments, hidden text | Drafts staff edit in Drive may contain unpublished text | Med | Confirm mammoth behaviour on tracked changes and comments in a spike (not verified); document it; offer a config switch to fail instead of publish if tracked changes are present. |
| Files: list folder (metadata only) and download from `read` mounts | Listed in scope; baseline drive access | Med | Stream, never buffer; correct `Content-Type`, `Content-Disposition`, `ETag`, `Last-Modified`; shallow listing only (no deep PROPFIND on hot path); max size cap; mount allow-list and path-traversal rejection (already in adapter). |
| HTTP caching on all read endpoints (ETag, `Cache-Control`, `If-None-Match` to 304) | Reads happen per website visit | Low-Med | Serve from cache; Drive revalidated on TTL by ETag (default 5 min). |
| Serve stale on Drive failure (stale-if-error) | mailbox.org has no SLA/webhooks and may throttle (429/503); website must not break when Drive is down | Med | Return last good cache with a staleness header; only 5xx when nothing is cached. Directly follows from the "no Drive round trip on hot path" requirement. |
| OpenAPI at `/docs`, `/health`, `/ready` | Expected of any API product | Low-Med | `/ready` should check MongoDB; Drive reachability should degrade (report, not fail) because reads are served from cache. |
| Structured logs without personal data, request ID | Records are personal data | Low | Log record IDs, collection names, status; never bodies, emails, or IPs by default. |

## Differentiators

Not expected by every user, but valued and mostly cheap given the architecture. Pick a few for v1.x, not all for v1.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Privacy-by-default: no IP / User-Agent / referrer stored with records | Honest GDPR story versus hosted form backends; fits non-profit buyer | Low | Mostly a "do not build" discipline plus docs. Pair with data-processing notes (Art. 28 agreement for Drive). |
| Schema-to-OpenAPI per collection (generated request/response schemas) | Frontend devs get typed docs for each form without hand-writing | Low-Med | Falls out of Fastify + JSON Schema if schemas are registered as routes' schemas. |
| Optimistic concurrency via `ETag` / `If-Match` on PUT/PATCH/DELETE | Prevents lost updates when two staff tools edit a record | Low | Use `updatedAt` or a `version` counter as the ETag. 412 on mismatch. |
| Manual cache refresh (`POST /refresh` on sheet/document/file, apiKey) | No webhooks from mailbox.org, so staff say "I just edited it, why is the site stale?" | Low | Rate-limited; respects Drive backoff. Great payoff for little code. |
| Signed time-based form token (minimum fill time, expiry) | Catches bots that post instantly or replay old pages; no third party | Med | Needs a token-issuing endpoint plus a validation step. Better than CAPTCHA for privacy; defer to v1.x. |
| Self-hosted proof-of-work CAPTCHA (e.g. ALTCHA-style) as verifier option | No third-party data transfer; important for EU/GDPR-minded sites | Med | Only if the generic siteverify hook does not cover it. v1.x. Unverified; validate maturity before committing. |
| Plain HTML form POST (`application/x-www-form-urlencoded`) with redirect-to-thanks-page | Works with no-JS sites (the Formspree classic) | Med | Needs string-to-schema coercion, redirect config, and CSRF/abuse thinking because it is a "simple" request that skips CORS preflight. Defer; JSON-only first. |
| Per-collection record retention (auto-delete after N days) | Data minimisation; fits GDPR | Low-Med | Mongo TTL index is trivial, but mirror regeneration and Drive file versions/trash keep old copies. Pair with the v2 erasure work. |
| Document metadata (title, last modified, word count, headings outline) alongside Markdown | Sites render page titles/tables of contents without parsing | Low | From docx core properties and the converted tree. |
| Draft/published convention without code (mount `published/` folder, or `status` column filter) | Safe publishing flow for staff | Low | Documentation + sheet filter defaults; cheaper and safer than building workflow. |
| `GET` collection export as CSV/NDJSON (apiKey) | Quick data portability and an exit-path story | Low-Med | Apply the same formula-guard as the mirror. |
| Batch create (apiKey only) | Imports and migrations | Med | Never on anonymous endpoints. |
| Prometheus `/metrics` | Ops visibility (mirror lag, cache hit ratio, Drive 429 count) | Low-Med | Useful once running in production; not v1. |

## Anti-Features

Deliberately do not build (in v1, and in some cases ever).

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| Admin UI / form builder / dashboard | Out of scope; huge surface; Directus/NocoDB/Baserow already do it | Config files + OpenAPI; staff use Drive and `.xlsx` |
| Admin REST endpoints to create collections/schemas at runtime | Needs auth model, migrations, and rollback; schema drift between Mongo, mirror and docs | Config-defined collections, restart or reload to apply |
| Sync edits from the mirrored `.xlsx` back to MongoDB | Conflict resolution, partial-write corruption, trust of staff-edited cells | One-way mirror, documented as read-only by convention; changes go through the API |
| Email notification per submission | Needs SMTP, puts personal data in mail, deliverability work; staff already read the mirror | Webhooks in v2; optionally a digest later |
| Third-party spam scoring (Akismet-style content analysis) | Sends submission content (personal data) to a third party; GDPR burden | Honeypot, CAPTCHA, time token, schema constraints |
| File attachments on form submissions (multipart upload) | Malware, size abuse, storage cost, personal data in arbitrary files, writes of arbitrary files into Drive | Text fields only in v1; revisit with object storage (v3) |
| Query DSL, aggregations, joins/relations, full-text search | Becomes a database product; injection surface; unindexed scans | Equality/range filters on declared indexed fields; consumers filter client-side or add an index |
| Realtime/subscriptions (WebSocket/SSE) | PocketBase/Directus feature, no use case; no upstream change events anyway | Polling with ETag/304 |
| Docs to Markdown round-trip (Markdown to `.docx`) or editing documents via API | Lossy and risky; Drive is the editor | Read-only conversion |
| Arbitrary path access on mounts for anonymous callers | Exposes whatever staff drop in a folder | Named resources in config; listing/download only for explicitly allowed mounts and policies |
| Public share links / signed URL generation for Drive files | Different trust model, mailbox.org sharing semantics unknown | Stream through the API under access policy |
| Soft-delete with indefinite tombstones for personal data | Conflicts with erasure expectations; tombstones are still personal data | Hard delete in v1 (leaning; flagged for discuss-phase) and a documented note that Drive versions/trash may retain mirror copies until the v2 erasure work |
| Multi-tenant hosting / per-customer billing | Self-hosted, single deployer model | One deployment per organisation |
| Official client SDKs | Maintenance cost | OpenAPI document; consumers generate clients |
| Hosting/operating Keycloak or Kong | Stated out of scope | Reference configs only |

## Feature Dependencies

```
Config loader (fail-fast) ─┬─> Collection definitions ─┬─> Create record ─┬─> Idempotency-Key
                           │                           │                  ├─> Honeypot / CAPTCHA hook
                           │                           │                  └─> Rate limit / payload limit / CORS
                           │                           ├─> Access policies (anonymous | apiKey) ─> Hashed API keys
                           │                           ├─> List/Get/Replace/Patch/Delete ─> Indexed-field filters
                           │                           └─> Mirror columns (schema or mapping)
                           └─> Mounts (allow-list) ─> StorageAdapter (WebDAV) ─┬─> Mirror writer (atomic temp+move, debounce, lock)
                                                                                ├─> Sheets ─> Column allow-list ─> ETag cache ─> stale-if-error
                                                                                ├─> Documents (.docx→MD) ─> ETag cache
                                                                                └─> Files list/download (streaming)

Create/Update/Delete record ─> Mirror regeneration ─> Mirror status / rebuild endpoint
ETag cache ─> HTTP caching (304) ─> Manual refresh endpoint
MongoDB (records, idempotency keys with TTL, cache, mirror lease)
WebDAV behaviour spike (locking, ETag stability, versioning, path encoding) ─> Mirror writer, ETag cache design
Record retention (differentiator) ─> mirror rebuild ─> v2 erasure (Drive versions/trash)
```

Notes: the mirror depends on the spike results; if ETags are unstable on OX WebDAV, the sheet/document revalidation strategy (ETag vs `last-modified` + size) must change. Anonymous create does not depend on the mirror being healthy (write is acknowledged once stored in MongoDB).

## MVP Recommendation (v1.0)

Ordered to match "forms first, read-only content second":

1. Config + StorageAdapter + mounts + health (foundation; unblocks everything).
2. Collection create path with full hardening: schema validation, payload limit, content-type check, CORS, rate limit, honeypot, minimal response, problem+json errors.
3. Mirror writer (debounce, atomic, single writer, formula-safe) with status/rebuild endpoint.
4. Access policies and hashed API keys; list/get/replace/patch/delete with cursor pagination and indexed filters.
5. Idempotency-Key and CAPTCHA siteverify hook (late in the forms phase; cheap once create is stable).
6. Sheets (column allow-list, ETag cache, stale-if-error), then Documents, then Files.
7. OpenAPI, caching headers, manual refresh endpoint, logs, CI.

Include one cheap differentiator in v1: manual cache refresh (solves the biggest staff complaint with polling).

Defer to v1.x: signed form token, self-hosted CAPTCHA, urlencoded form POST + redirect, CSV/NDJSON export, retention TTL, batch create, `/metrics`.
Defer to v2.0+: OIDC/roles, webhooks/change feed, GDPR erasure, image assets, S3-compatible API, file attachments.

Open product decisions this research bears on (for discuss-phase): config-only collections (recommended); API keys in config for v1 with hashed values and multiple active keys for rotation; hard delete for personal-data collections; one workbook per collection (simpler lock and rebuild semantics than one shared workbook; recommended).

## Confidence by Area

| Area | Confidence | Notes |
|------|------------|-------|
| Form-backend table stakes | MEDIUM | Basin documentation read via search summary; Formspree specifics and CAPTCHA provider API details from prior knowledge, not re-verified |
| Spreadsheet-as-backend features | MEDIUM | SheetDB limits from its own docs snippet; pricing figures conflict across sources and are not used |
| Idempotency convention | MEDIUM | IETF draft status confirmed through revision 07 (Oct 2025), no newer revision found; may be stale |
| Docs-as-CMS pitfalls | LOW-MEDIUM | Tracked-change and comment handling in mammoth unverified; needs a spike |
| Mirror and WebDAV feasibility | LOW | Depends on OX App Suite behaviour (spike in PROJECT.md) |

## Sources

- [Basin spam protection documentation](https://docs.usebasin.com/guides/spam-protection) (vendor docs, MEDIUM)
- [Basin features](https://usebasin.com/features) and [Basin how it works](https://docs.usebasin.com/getting-started/how-basin-works/) (vendor, MEDIUM)
- [IETF draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header) (official draft, revision 07 Oct 2025; expiry lapsed, HIGH for the fact, MEDIUM for current status)
- [SheetDB limits](https://docs.sheetdb.io/limits) and [SheetDB pricing](https://sheetdb.io/pricing) (vendor, MEDIUM)
- [Sheet Best vs Sheety](https://sheetbest.com/blog/sheetbest-vs-sheety/), [dev.to Google Sheets to API comparison](https://dev.to/sara_builds_all/best-google-sheets-to-api-services-compared-2026-5891) (competitor/community blogs, LOW)
- Prior knowledge of PocketBase, Directus, NocoDB, Baserow feature sets, Fetch/CORS "simple request" rules, RFC 7396, RFC 9457 (not re-fetched this session, MEDIUM)
