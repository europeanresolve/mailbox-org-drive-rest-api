# Phase 2: Collections, Access Policy and Anonymous Hardening - Context

**Gathered:** 2026-11-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Config-defined collections (JSON Schema, indexed fields, per-operation policies) with strict-validated CRUD stored in MongoDB; default-deny `anonymous` / `apiKey` access with hashed, rotatable API keys; hardened anonymous create (body limit, content type, CORS, per-IP rate limit behind trusted proxies, honeypot, Idempotency-Key); an OpenAPI 3.1 document and UI at `/docs` generated from config; a Kong reference config in `deploy/`.

Covers COLL-01..08, SEC-01..06, SEC-08, SEC-09, FND-04. **SEC-07 (CAPTCHA siteverify) is dropped** (see D-07). The `.xlsx` mirror is Phase 3; read-only content routes are Phase 4.
</domain>

<decisions>
## Implementation Decisions

### API keys (SEC-02)
- **D-01:** Keys live in `config.yaml` as a name plus a SHA-256 hash. A bundled keygen command prints a fresh key and its hash. Rotation: add the new key, restart, remove the old one; several keys may be active at once. Access goes through a `KeyStore` interface so a MongoDB store can come later without touching route code. — **Reversibility:** one-way — the key entries are part of the published config format (Phase 1 D-16).
- **D-02:** Grants are listed on the key, as exact `collection:operation` strings (operations: `create`, `get`, `list`, `replace`, `patch`, `delete`). No wildcards. A grant naming an unknown collection or operation fails startup with the other config errors.
- **D-03:** An operation whose policy is `apiKey` accepts any active key that holds the grant for it. An operation with no policy is denied (SEC-01). A missing or wrong key gets 401 problem+json, and a valid key without the grant gets 403.
- **D-04:** The key travels in `Authorization: Bearer <key>`, already redacted in pino. Keys carry a fixed recognisable prefix (e.g. `mdra_`) so secret scanners can spot leaks. OpenAPI declares an `http` bearer scheme. — **Reversibility:** one-way — clients and gateways are configured to send this header.
- **D-05:** Anonymous routes are hardened the same way whatever headers arrive. A key never bypasses the honeypot, rate limit or other anonymous checks, so there is one code path. Server-side integrations use an operation set to `apiKey`.

### Anonymous form behaviour (SEC-03..06, SEC-08)
- **D-06:** The first adopter's website backend checks the CAPTCHA and then calls this API with an API key (apiKey create). Anonymous create is still built and hardened in full as a generic feature for other deployers.
- **D-07:** **SEC-07 is dropped entirely.** CAPTCHA is always the caller's job, and the README says that anonymous endpoints rely on the honeypot, rate limit, CORS and gateway. REQUIREMENTS.md (move SEC-07 to Out of Scope) and ROADMAP Phase 2 success criterion 2 ("a failed CAPTCHA verification is rejected") must be updated to match.
- **D-08:** Honeypot: the field name is set per collection in config. When it is filled, the response is a fake `201` with the same shape as a real anonymous create (random UUID, current `createdAt`), and nothing is stored or logged as personal data. The honeypot field is removed before strict validation, the one allowed exception to no-stripping, and it must not appear in the collection schema (checked at startup).
- **D-09:** Idempotency-Key works on create for both anonymous and apiKey callers. It is scoped per collection and key value and kept for 24 h by a MongoDB TTL index. The stored entry holds a hash of the request body and the original response. The same key with a different body gets 422 problem+json. A duplicate that arrives while the first request is still in flight gets 409.
- **D-10:** Client IP: `server.trustProxy` is a list of proxy IPs/CIDRs and is empty by default. When it is empty, `X-Forwarded-For` is ignored and the socket address is the client. A test shows that a forged `X-Forwarded-For` from an untrusted peer does not change the rate-limit bucket. Rationale given to the user: the setting does not limit who can call the API, only whose forwarded-IP header is believed. — **Reversibility:** one-way — part of the config format.
- **D-11:** Rate limit: an in-memory per-IP limit per collection on anonymous routes, configurable per collection with a default of about 10 requests a minute. 429 is returned as problem+json.
- **D-12:** CORS: each collection lists its allowed origins. A browser request whose `Origin` is not in the list is rejected. Requests with no `Origin` (servers, curl) pass CORS but still meet every other anonymous check.

### Delete (COLL-06)
- **D-13:** Hard delete: the document is removed from MongoDB. No tombstones and no `deletedAt`. Phase 3's mirror picks up deletes by regenerating from MongoDB.
- **D-14:** DELETE on an ID that does not exist gets 404 problem+json, the same as GET. A successful delete gets 204.

### API surface and queries (COLL-03..05, FND-04)
- **D-15:** Collection routes are `/v1/{name}` (create, list) and `/v1/{name}/{id}` (get, replace, patch, delete). `/health`, `/ready` and `/docs` stay unversioned at the root. — **Reversibility:** one-way — the URL shape is part of the public API contract.
- **D-16:** The Phase 4 read routes also live under `/v1` (`/v1/files/{mount}/...`, `/v1/sheets/...`, `/v1/documents/...`), which updates the example path in Phase 1 D-19. Startup rejects a collection whose name is on a reserved list (at least `files`, `sheets`, `documents`, `mirror`, `admin`, `docs`, `health`, `ready`). Collection names follow the same naming rule as mount names (`MOUNT_NAME_PATTERN`).
- **D-17:** List filters use dot syntax: `?status=new` for equality, and `?createdAt.gte=2026-01-01` for ranges, with operators `eq`, `gt`, `gte`, `lt`, `lte`. Values are typed from the field's schema type, with no loose coercion. A non-indexed field, an unknown operator or a value of the wrong type gets 400. `createdAt` and `updatedAt` are always filterable and sortable.
- **D-18:** Indexed fields may be dotted paths to nested scalar properties (e.g. `address.country`). The operator is the last dot segment only when it is a known operator name, so a field segment may not be named `eq`, `gt`, `gte`, `lt` or `lte` (startup check). Indexed paths must resolve to scalar schema types (string, number, integer, boolean, date-time string) and never pass through arrays.
- **D-19:** Lists can sort by any indexed field: `?sort=field` or `?sort=-field`, defaulting to `-createdAt`. Pagination is keyset on `(sortField, _id)` with an opaque `cursor` and `?limit=` (default 50, max 200). No `skip`. One MongoDB index is created per indexed field, compound with `_id`.
- **D-20:** PUT and PATCH accept an optional `If-Match`. GET, create, PUT and PATCH return an `ETag` derived from a per-record version. A stale `If-Match` gets 412. With no `If-Match` the last write wins. The update is an atomic `findOneAndUpdate` filtered on the version, within the portable Mongo subset (Phase 1 D-22). PATCH is RFC 7396 merge-patch (`application/merge-patch+json`) and is validated after the merge.

### Claude's Discretion
- The collection definition layout in `config.yaml` (inline schema vs `$ref` to a sibling file, both allowed per Phase 1 D-18), and where policies, indexes, honeypot, CORS and rate-limit settings sit.
- The list response envelope (e.g. `{ items, nextCursor }`).
- Whether `/docs` is on by default or can be turned off in config.
- How SEC-03's "required `maxLength` on strings" is enforced: a startup rejection of anonymous-create schemas that have unbounded strings is the expected reading.
- The keygen command's form (CLI subcommand vs script), the key length, and the exact prefix.
- Status codes the decisions above do not pin (e.g. 415 for a wrong content type, 413 for an oversized body).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scope and requirements
- `.planning/ROADMAP.md` §Phase 2: goal and success criteria (criterion 2's CAPTCHA clause is void per D-07)
- `.planning/REQUIREMENTS.md`: COLL-01..08, SEC-01..09, FND-04 (SEC-07 dropped)
- `.planning/PROJECT.md`: constraints (privacy, no PII in logs, generic and organisation-agnostic) and the Key Decisions table

### Prior decisions
- `.planning/phases/01-foundations-ox-spike-and-storage-layer/01-CONTEXT.md`: D-16..D-19 (config format, secrets via env/`*_FILE`, `$ref` siblings, mount naming), D-22 (portable Mongo subset)

### Research
- `.planning/research/STACK.md`: Ajv separate instance (draft 2020-12, strict, no coercion), SHA-256 key hashing, `@fastify/rate-limit` + `trustProxy`, `@fastify/cors`, `@fastify/swagger` OpenAPI 3.1, keyset pagination, `crypto.randomUUID()` ids
- `.planning/research/ARCHITECTURE.md`, `.planning/research/PITFALLS.md`, `.planning/research/FEATURES.md`: architecture and pitfalls relevant to collections and anonymous endpoints
</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/config/schema.ts` + `src/config/load.ts` (`loadConfig`, `ConfigError`, `ConfigIssue`): extend the TypeBox config schema with `collections`, `apiKeys` and `server.trustProxy`. Issues are already collected and reported all at once.
- `MOUNT_NAME_PATTERN` (`src/config/`): reuse it for collection names.
- `src/http/logging.ts`: problem+json 404 and error handlers that echo no input, and route-template logging. Collection errors extend this; they do not add a parallel error path.
- `src/db/mongo.ts` (`createMongo`, `Mongo`): the Mongo client for records, idempotency entries and indexes.
- `buildApp(options)` in `src/app.ts`: the composition root where collection routes, auth, CORS, rate limit and swagger register.

### Established Patterns
- Fastify `inject()` for HTTP tests, and integration tests against the Compose stack only (Phase 1 D-03).
- `requestIdHeader: false` and custom single-line request logging: never log bodies, raw URLs or query strings, because filters can carry personal data. The canary harness must be extended to the new error paths (validation, auth, 409/412/422/429).
- Startup failures list every problem at once and never print a config value (this applies to key hashes as well).

### Integration Points
- `src/app.ts` `buildApp` and `src/server.ts` `start` wire config into the new plugins.
- `config/config.example.yaml`: add a synthetic example collection, key and trustProxy entry.
</code_context>

<specifics>
## Specific Ideas

- The first adopter's forms flow is website backend (CAPTCHA verified there) → `POST /v1/{name}` with an apiKey. Anonymous browser posting is a generic capability, not the adopter's path.
</specifics>

<deferred>
## Deferred Ideas

- MongoDB-backed `KeyStore` with key-management endpoints (rotation without restart): later, behind the D-01 interface.
- CAPTCHA verification inside the API (SEC-07): dropped, not deferred. Revisit only if a deployer needs browser-direct anonymous posting with CAPTCHA.
</deferred>

---

*Phase: 02-collections-access-policy-and-anonymous-hardening*
*Context gathered: 2026-11-22*
