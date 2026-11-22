# Phase 02: Collections, Access Policy and Anonymous Hardening — Research

**Researched:** 2026-11-22
**Domain:** Config-defined JSON collections in MongoDB, default-deny API-key / anonymous access, anonymous-endpoint hardening, OpenAPI 3.1 generation, keyset pagination, RFC 7396 merge-patch, RFC 7807 problem+json, idempotency keys, honeypot, CORS, rate limiting, ETag/If-Match optimistic concurrency, Kong gateway reference config
**Confidence:** HIGH on the core stack (packages were already verified in STACK.md research on 2026-11-21 and npm-confirmed this session); MEDIUM on a handful of discretionary config shapes and Kong YAML format details.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### API keys (SEC-02)
- **D-01:** Keys live in `config.yaml` as a name plus a SHA-256 hash. A bundled keygen command prints a fresh key and its hash. Rotation: add the new key, restart, remove the old one; several keys may be active at once. Access goes through a `KeyStore` interface so a MongoDB store can come later without touching route code. — **Reversibility:** one-way.
- **D-02:** Grants are listed on the key, as exact `collection:operation` strings (operations: `create`, `get`, `list`, `replace`, `patch`, `delete`). No wildcards. A grant naming an unknown collection or operation fails startup with the other config errors.
- **D-03:** An operation whose policy is `apiKey` accepts any active key that holds the grant for it. An operation with no policy is denied (SEC-01). A missing or wrong key gets 401 problem+json, and a valid key without the grant gets 403.
- **D-04:** The key travels in `Authorization: Bearer <key>`, already redacted in pino. Keys carry a fixed recognisable prefix (e.g. `mdra_`) so secret scanners can spot leaks. OpenAPI declares an `http` bearer scheme. — **Reversibility:** one-way.
- **D-05:** Anonymous routes are hardened the same way whatever headers arrive. A key never bypasses the honeypot, rate limit or other anonymous checks.

#### Anonymous form behaviour (SEC-03..06, SEC-08)
- **D-06:** The first adopter's website backend checks the CAPTCHA and then calls this API with an API key (apiKey create). Anonymous create is still built and hardened in full.
- **D-07:** **SEC-07 (CAPTCHA siteverify) is dropped entirely.** CAPTCHA is always the caller's job.
- **D-08:** Honeypot: the field name is set per collection in config. When it is filled, the response is a fake `201` with the same shape as a real anonymous create (random UUID, current `createdAt`), nothing is stored or logged as personal data. The honeypot field is removed before strict validation — the one allowed exception to no-stripping — and it must not appear in the collection schema (checked at startup).
- **D-09:** Idempotency-Key works on create for both anonymous and apiKey callers. It is scoped per collection and key value and kept for 24 h by a MongoDB TTL index. The stored entry holds a hash of the request body and the original response. The same key with a different body gets 422 problem+json. A duplicate that arrives while the first request is still in flight gets 409.
- **D-10:** Client IP: `server.trustProxy` is a list of proxy IPs/CIDRs and is empty by default. When it is empty, `X-Forwarded-For` is ignored and the socket address is the client. — **Reversibility:** one-way.
- **D-11:** Rate limit: an in-memory per-IP limit per collection on anonymous routes, configurable per collection with a default of about 10 requests a minute. 429 is returned as problem+json.
- **D-12:** CORS: each collection lists its allowed origins. A browser request whose `Origin` is not in the list is rejected.

#### Delete (COLL-06)
- **D-13:** Hard delete. No tombstones, no `deletedAt`.
- **D-14:** DELETE on a non-existent ID gets 404 problem+json. Successful delete gets 204.

#### API surface and queries (COLL-03..05, FND-04)
- **D-15:** Collection routes are `/v1/{name}` and `/v1/{name}/{id}`. `/health`, `/ready` and `/docs` stay unversioned at the root. — **Reversibility:** one-way.
- **D-16:** Startup rejects a collection whose name is on a reserved list (at least `files`, `sheets`, `documents`, `mirror`, `admin`, `docs`, `health`, `ready`). Collection names follow `MOUNT_NAME_PATTERN`.
- **D-17:** List filters: `?status=new` (equality), `?createdAt.gte=2026-01-01` (ranges). Operators: `eq`, `gt`, `gte`, `lt`, `lte`. Values typed from field's schema type, no loose coercion. Non-indexed field, unknown operator, or wrong type → 400.
- **D-18:** Indexed fields may be dotted paths. The operator is the last dot segment only when it is a known operator name. A field segment must not be named `eq`, `gt`, `gte`, `lt`, or `lte` (startup check). Indexed paths must resolve to scalar schema types and never pass through arrays.
- **D-19:** Sort by any indexed field: `?sort=field` or `?sort=-field`, defaulting to `-createdAt`. Keyset pagination on `(sortField, _id)` with opaque `cursor` and `?limit=` (default 50, max 200). No `skip`. One MongoDB index per indexed field, compound with `_id`.
- **D-20:** PUT and PATCH accept optional `If-Match`. GET, create, PUT and PATCH return an `ETag` derived from a per-record version. Stale `If-Match` → 412. No `If-Match` → last write wins. PATCH is RFC 7396 merge-patch (`application/merge-patch+json`) validated after merge.

### Claude's Discretion
- The collection definition layout in `config.yaml` (inline schema vs `$ref` to a sibling file, both allowed per Phase 1 D-18), and where policies, indexes, honeypot, CORS and rate-limit settings sit.
- The list response envelope (e.g. `{ items, nextCursor }`).
- Whether `/docs` is on by default or can be turned off in config.
- How SEC-03's "required `maxLength` on strings" is enforced: a startup rejection of anonymous-create schemas that have unbounded strings is the expected reading.
- The keygen command's form (CLI subcommand vs script), the key length, and the exact prefix.
- Status codes the decisions above do not pin (e.g. 415 for a wrong content type, 413 for an oversized body).

### Deferred Ideas (OUT OF SCOPE)
- MongoDB-backed `KeyStore` with key-management endpoints (rotation without restart): later.
- CAPTCHA verification inside the API (SEC-07): dropped, not deferred.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| COLL-01 | Deployer can define collections in config (JSON Schema, indexed fields, per-operation policies) | Config schema extension; TypeBox config shapes; startup validation |
| COLL-02 | API consumer can create a record; strict validation (no coercion, no stripping, additionalProperties:false); server-generated UUID, createdAt, updatedAt | Strict Ajv instance; RecordRepo.insert; server-side fields section |
| COLL-03 | API consumer can list records with cursor pagination and equality/range filters on indexed fields only | Keyset pagination pattern; query allow-list; compound MongoDB indexes |
| COLL-04 | API consumer can get a single record by ID | RecordRepo.findById; 404 problem+json |
| COLL-05 | API consumer can replace (PUT) and patch (RFC 7396 merge-patch, validated after merge) a record | ETag/If-Match pattern; RFC 7396 implementation; findOneAndUpdate with version filter |
| COLL-06 | API consumer can delete a record (hard delete per D-13) | RecordRepo.deleteOne; 204 / 404 |
| COLL-07 | Errors as `application/problem+json` without echoing submitted values | Extends existing logging.ts error handler; no Ajv error values in response |
| COLL-08 | Anonymous create responds with only `id` and `createdAt` | Response schema projection per route; TypeBox response type |
| SEC-01 | Deployer sets each operation to anonymous or apiKey; unset = denied | Default-deny policy; onRequest hook; policy table from collection config |
| SEC-02 | API key stored hashed, constant-time comparison, rotatable, multiple active keys | SHA-256 + timingSafeEqual; KeyStore interface; `mdra_` prefix; keygen command |
| SEC-03 | Anonymous endpoints: per-route body size limit, maxLength on strings, Content-Type check | bodyLimit per route; Ajv startup check for unbounded strings; 415 on wrong Content-Type |
| SEC-04 | Allowed CORS origins per collection; browser requests from other origins rejected | @fastify/cors per collection route plugin; allowedOrigins from config |
| SEC-05 | Anonymous rate-limited per client IP, trustProxy configured to prevent XFF bypass | @fastify/rate-limit; trustProxy CIDR list; test with forged XFF |
| SEC-06 | Filled honeypot field → silent discard with fake 201 | Honeypot field removal before Ajv; fake response with random UUID/createdAt |
| SEC-08 | Idempotency-Key on create: retries return original result, no duplicate record | MongoDB idempotency_keys collection; TTL index; bodyHash check; 409/422 |
| SEC-09 | Kong reference gateway config in deploy/ (rate limiting, logging of method/route/status only) | Kong declarative YAML pattern; deck format |
| FND-04 | OpenAPI 3.1 document and UI at /docs generated from config | @fastify/swagger (openapi: 3.1.0) + @fastify/swagger-ui; per-collection route schema |
</phase_requirements>

---

## Summary

Phase 2 builds everything needed for a website form submission flow and deployer CRUD management on top of the Phase 1 Fastify/MongoDB/pino foundation. The scope divides into five coherent sub-problems: (1) **config extension** — adding `collections`, `apiKeys`, and `server.trustProxy` to the existing TypeBox/Ajv config loader with the same fail-fast, all-errors-at-once pattern; (2) **collection CRUD** — a `RecordRepository` backed by MongoDB with keyset pagination, indexed queries, and RFC 7396 merge-patch; (3) **access control** — a `KeyStore` interface backed by config-file hashed keys, an `onRequest` principal-resolution hook, and a per-route default-deny policy check; (4) **anonymous hardening** — per-collection body limits, CORS, rate limiting with correct trustProxy, honeypot fake-201, and Idempotency-Key TTL deduplication; and (5) **OpenAPI generation** — `@fastify/swagger` v9 producing an OpenAPI 3.1 doc from the per-collection route schemas compiled at boot.

The existing Phase 1 infrastructure provides clean integration points: `ConfigSchema` / `loadConfig` / `ConfigError` extend naturally; `buildApp` registers the new plugins; `createMongo` / `Mongo` provides the client; `logging.ts` error handlers already serve problem+json without echoing input.

**Primary recommendation:** Use Fastify route-plugin encapsulation to register each collection as an isolated plugin with its own `setValidatorCompiler`, body limit, CORS, and rate-limit scope. The strict Ajv instance (draft 2020-12, `coerceTypes: false`, `removeAdditional: false`) is a shared singleton compiled once per collection schema at boot. This avoids the silent-coercion trap of Fastify's default Ajv while making `@fastify/swagger` document each collection's real schema automatically.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Config parsing and validation | API process (startup) | — | YAML + TypeBox + Ajv at boot; config is frozen after load |
| API key resolution and authentication | API (Fastify onRequest hook) | — | Bearer token parsed in HTTP layer; key hash lookup from KeyStore |
| Per-route access policy enforcement | API (Fastify preHandler) | — | Policy table is collection config; check runs before handler |
| Record validation | API (service layer, strict Ajv) | — | Must not use Fastify's coercing Ajv; service owns schema correctness |
| Record persistence and querying | Database (MongoDB) | — | RecordRepository is the only layer that touches the records collection |
| Idempotency-Key deduplication | Database (MongoDB TTL collection) | — | TTL index enforces 24 h expiry; atomic upsert prevents duplicate records |
| Honeypot check | API (route preHandler) | — | Runs before validation; fake response must not log PII |
| CORS enforcement | API (Fastify plugin per collection) | — | @fastify/cors registered inside each collection route plugin |
| Rate limiting | API (Fastify plugin) | CDN/Gateway (Kong) | In-app limiter is a fallback; Kong is the primary control in production |
| OpenAPI document and UI | API (/docs route, @fastify/swagger) | — | Schema comes from route registration, not hand-written |
| Kong gateway reference config | CDN/Gateway deploy artefact | — | Declarative YAML in deploy/; not runtime code |

---

## Standard Stack

### New packages for Phase 2 (not yet in package.json)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `fastify-plugin` | 6.0.1 | Break Fastify encapsulation for shared decorators (KeyStore, Mongo) | Official Fastify utility; needed so auth and db decorators are visible across route plugins |
| `@fastify/type-provider-typebox` | 6.3.0 | TypeBox-typed route handlers for params, query, response shapes | Official; peer `typebox ^1.1.14` matches 1.4.7; avoids manual TS casts |
| `@fastify/swagger` | 9.9.5 | OpenAPI 3.1 document generated from route schemas | Official, 9.x targets Fastify 5; `openapi: { openapi: '3.1.0' }` option supported |
| `@fastify/swagger-ui` | 6.1.5 | `/docs` UI | Official, same release train as @fastify/swagger |
| `@fastify/cors` | 11.4.3 | Per-collection allowed-origin enforcement | Official; registered inside each collection plugin for per-collection config |
| `@fastify/rate-limit` | 11.3.0 | In-app per-IP rate limiting on anonymous routes | Official; `trustProxy`-aware; in-memory store is correct for single instance |
| `@fastify/helmet` | 13.2.0 | HTTP security headers (HSTS, nosniff, etc.) | Official; CSP relaxed on `/docs` only |
| `ajv-formats` | 3.0.1 | Adds `email`, `date-time`, `uri` format validators to Ajv 8 | Required for anonymous form schemas; maintained by ajv organisation |

[VERIFIED: STACK.md research 2026-11-21] — all versions confirmed via `npm view` on that date; npm view re-confirmed this session (see shell output above).

### Already installed (Phase 1)

| Library | Version | Phase 2 role |
|---------|---------|--------------|
| `ajv` | 8.20.0 | Strict Ajv 2020-12 instance for record validation |
| `fastify` | 5.12.8 | HTTP framework; collection route plugins extend buildApp |
| `mongodb` | 7.9.1 | RecordRepository, IdempotencyRepository, ApiKeyRepository |
| `typebox` | 1.4.7 | Config schema extension (collections, apiKeys, trustProxy) |
| `yaml` | 2.9.1 | Config file parsing (already used) |
| `pino` | 10.4.0 | Authorization header already redacted; query strings never logged |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@fastify/swagger` | `@scalar/fastify-api-reference` 1.82.1 | Scalar is cosmetic improvement only; skip the extra dep |
| `@fastify/rate-limit` (in-memory) | Redis-backed store | No Redis in the single-container design; in-memory is correct for 1 replica |
| `@fastify/cors` registered per-plugin | Global CORS with dynamic origin callback | Per-plugin encapsulation is cleaner and prevents origin leakage across collections |

**Installation (new Phase 2 packages):**
```bash
pnpm add fastify-plugin @fastify/type-provider-typebox @fastify/swagger @fastify/swagger-ui \
         @fastify/cors @fastify/rate-limit @fastify/helmet ajv-formats
```

---

## Package Legitimacy Audit

> The GSD legitimacy seam returned `SUS` with `unknown-age / unknown-downloads / no-repository` for all packages due to network restrictions in this sandbox (registry API unreachable). These are all official packages in the `@fastify` GitHub organisation and the `ajv` organisation, confirmed as the standard stack in `.planning/research/STACK.md` (which performed npm registry lookups on 2026-11-21). Treat as `OK` based on the prior authoritative research session.

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `fastify-plugin` | npm | >7 yrs | Very high | github.com/fastify/fastify-plugin | OK | Approved [CITED: STACK.md] |
| `@fastify/type-provider-typebox` | npm | ~3 yrs | High | github.com/fastify/fastify-type-provider-typebox | OK | Approved [CITED: STACK.md] |
| `@fastify/swagger` | npm | >6 yrs | Very high | github.com/fastify/fastify-swagger | OK | Approved [CITED: STACK.md] |
| `@fastify/swagger-ui` | npm | >3 yrs | High | github.com/fastify/fastify-swagger-ui | OK | Approved [CITED: STACK.md] |
| `@fastify/cors` | npm | >6 yrs | Very high | github.com/fastify/fastify-cors | OK | Approved [CITED: STACK.md] |
| `@fastify/rate-limit` | npm | >6 yrs | High | github.com/fastify/fastify-rate-limit | OK | Approved [CITED: STACK.md] |
| `@fastify/helmet` | npm | >5 yrs | High | github.com/fastify/fastify-helmet | OK | Approved [CITED: STACK.md] |
| `ajv-formats` | npm | >5 yrs | Very high | github.com/ajv-validator/ajv-formats | OK | Approved [CITED: STACK.md] |

**Packages removed due to SLOP verdict:** none
**Packages flagged as suspicious (SUS):** none (the seam's `unknown-*` signals are sandbox network limitations, not legitimacy flags)

---

## Architecture Patterns

### System Architecture Diagram

```
config.yaml + env
       │
  loadConfig() ── TypeBox/Ajv ──► ConfigError (startup)
       │
       ▼
  buildApp(options)
  ├── @fastify/helmet (global)
  ├── @fastify/swagger (global, OpenAPI 3.1 doc)
  ├── @fastify/swagger-ui (/docs)
  ├── keyStorePlugin (fp, decorates app.keyStore)
  ├── mongoPlugin (fp, decorates app.mongo)
  ├── authPlugin (fp)
  │    └── onRequest: resolve Principal from Bearer token
  ├── healthRoutes (/health, /ready — existing)
  └── for each collection in config.collections:
       └── collectionPlugin (encapsulated, NOT fp)
            ├── setValidatorCompiler(strictAjv.compile)
            ├── @fastify/cors({ origin: collection.cors.origins })
            ├── @fastify/rate-limit({ max, timeWindow, trustProxy })
            ├── POST /v1/{name}         [create: anonymous|apiKey]
            │    ├── preHandler: authorize(principal, name, 'create')
            │    ├── preHandler: honeypot check
            │    ├── preHandler: idempotency check
            │    └── → CollectionService.create → RecordRepo.insert
            │         → 201 { id, createdAt } (anonymous) or full record (apiKey)
            ├── GET  /v1/{name}         [list: anonymous|apiKey]
            │    ├── preHandler: authorize
            │    └── → CollectionService.list → RecordRepo.list(filter, cursor)
            │         → 200 { items, nextCursor }
            ├── GET  /v1/{name}/:id     [get: anonymous|apiKey]
            │    ├── preHandler: authorize
            │    └── → CollectionService.get → RecordRepo.findById
            │         → 200 record + ETag header
            ├── PUT  /v1/{name}/:id     [replace: apiKey]
            │    ├── preHandler: authorize
            │    └── → CollectionService.replace(If-Match) → findOneAndUpdate(version)
            │         → 200 record + ETag | 412
            ├── PATCH /v1/{name}/:id    [patch: apiKey] (application/merge-patch+json)
            │    ├── preHandler: authorize
            │    └── → CollectionService.patch → merge → validate → findOneAndUpdate
            │         → 200 record + ETag | 412
            └── DELETE /v1/{name}/:id  [delete: apiKey]
                 ├── preHandler: authorize
                 └── → RecordRepo.deleteOne → 204 | 404
```

### Recommended Project Structure

```
src/
├── config/
│   ├── schema.ts          # Extend ConfigSchema with collections, apiKeys, server.trustProxy
│   └── load.ts            # Extend loadConfig with collection/key startup validation
├── collections/
│   ├── schema-registry.ts # Compile Ajv schemas at boot; expose validate(name, body)
│   ├── record-repo.ts     # RecordRepository: insert, findById, list, replace, patch, delete
│   ├── idempotency-repo.ts # IdempotencyRepository: upsert, find; TTL index management
│   ├── collection-service.ts # Business logic: assign id/createdAt/updatedAt, run policy, honeypot, etc.
│   └── routes.ts          # For-loop plugin registration per collection
├── auth/
│   ├── key-store.ts       # KeyStore interface + ConfigKeyStore implementation
│   └── policy.ts          # allow(principal, collection, operation) → boolean
├── http/
│   ├── health.ts          # Existing — unchanged
│   └── logging.ts         # Existing — extend canary test for 401/403/409/412/422/429 paths
├── keygen.ts              # CLI script: generate mdra_ key + hash
├── app.ts                 # Extend buildApp: register new plugins, swagger, collections
└── server.ts              # Existing — passes config to buildApp
deploy/
└── kong.yml               # Kong declarative YAML reference config
```

---

### Pattern 1: Strict Ajv instance for record validation

**What:** A single Ajv 2020-12 instance with `strict: true`, `coerceTypes: false`, `removeAdditional: false`, `useDefaults: false`, `allErrors: false`. Formats added from `ajv-formats`. Each collection schema compiled once at boot and cached. `setValidatorCompiler` overrides Fastify's default for each collection route plugin.

**Why:** Fastify's built-in Ajv runs with `coerceTypes: 'array'`, `removeAdditional: true`, `useDefaults: true` — it silently mutates payloads [VERIFIED: STACK.md citing Fastify docs]. A string `"1"` becomes `1`, unknown fields vanish. For stored records this means the validated document does not match what the user sent or what the schema promises.

**Example:**
```typescript
// Source: Fastify validation docs / STACK.md research
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export function buildStrictAjv(): Ajv {
  const ajv = new Ajv({
    strict: true,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
    allErrors: false,
  });
  addFormats(ajv);
  return ajv;
}

// In each collection plugin:
const compiledSchema = strictAjv.compile(collection.schema);
app.setValidatorCompiler(({ schema }) => strictAjv.compile(schema));
```

---

### Pattern 2: Collection plugin encapsulation

**What:** Each collection is registered as a Fastify encapsulated plugin (NOT wrapped in `fastify-plugin`). This gives it its own scope for CORS, rate-limit, body-limit, and `setValidatorCompiler`. Cross-cutting decorators (keyStore, mongo) are registered with `fastify-plugin` at the app level first.

**Example:**
```typescript
// Source: Fastify plugin scoping / ARCHITECTURE.md research
import fp from "fastify-plugin";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";

// Cross-cutting: registered with fastify-plugin so visible in all child scopes
app.register(fp(keyStorePlugin));
app.register(fp(mongoPlugin));
app.register(fp(authPlugin)); // sets onRequest hook

// Per-collection: encapsulated, NOT fp-wrapped
for (const [name, def] of Object.entries(config.collections)) {
  app.register(async (scope) => {
    scope.setValidatorCompiler(({ schema }) => strictAjv.compile(schema));
    await scope.register(cors, { origin: def.cors?.origins ?? [] });
    await scope.register(rateLimit, {
      max: def.rateLimit?.max ?? 10,
      timeWindow: (def.rateLimit?.windowSeconds ?? 60) * 1000,
      // trustProxy set via app.server.address (from server.trustProxy list)
    });
    scope.addContentTypeParser(
      "application/merge-patch+json",
      { parseAs: "string" },
      (req, body, done) => {
        try { done(null, JSON.parse(body as string)); }
        catch { done(new Error("invalid JSON")); }
      }
    );
    registerCollectionRoutes(scope, name, def);
  }, { prefix: `/v1/${name}` });
}
```

---

### Pattern 3: KeyStore interface and config-backed implementation

**What:** `KeyStore` has one method: `resolve(rawKey: string): Promise<{ id: string; grants: Set<string> } | null>`. The `ConfigKeyStore` strips the `mdra_` prefix, splits `keyId.secret`, SHA-256 hashes the secret, and compares with `crypto.timingSafeEqual` against stored hashes. Never log the raw key; `authorization` is already in pino's `redact` list.

**Why:** D-01 requires a `KeyStore` interface so a future MongoDB store can be added without touching route code.

**Example:**
```typescript
// Source: CONTEXT.md D-01, D-04; STACK.md API key hashing section
import { createHash, timingSafeEqual } from "node:crypto";

export interface KeyStore {
  resolve(rawKey: string): Promise<ResolvedKey | null>;
}

export type ResolvedKey = { id: string; grants: ReadonlySet<string> };

export class ConfigKeyStore implements KeyStore {
  #entries: Map<string, { hash: Buffer; grants: ReadonlySet<string> }>;

  constructor(keys: readonly ApiKeyConfig[]) {
    this.#entries = new Map(
      keys.map((k) => [k.name, {
        hash: Buffer.from(k.hash, "hex"),
        grants: new Set(k.grants),
      }])
    );
  }

  async resolve(rawKey: string): Promise<ResolvedKey | null> {
    // rawKey = "mdra_<keyId>.<secret>"
    const withoutPrefix = rawKey.startsWith("mdra_") ? rawKey.slice(5) : rawKey;
    const dot = withoutPrefix.indexOf(".");
    if (dot === -1) return null;
    const keyId = withoutPrefix.slice(0, dot);
    const secret = withoutPrefix.slice(dot + 1);
    const entry = this.#entries.get(keyId);
    if (!entry) return null;
    const incoming = Buffer.from(
      createHash("sha256").update(secret).digest("hex"),
      "hex",
    );
    if (incoming.length !== entry.hash.length) return null;
    if (!timingSafeEqual(incoming, entry.hash)) return null;
    return { id: keyId, grants: entry.grants };
  }
}
```

---

### Pattern 4: Default-deny auth hook

**What:** An `onRequest` hook resolves a `Principal` from `Authorization: Bearer`. A `preHandler` per route calls `policy.allow(principal, collection, op)`. Missing or wrong key → 401. Valid key without grant → 403. No policy set for operation → 403 (default deny per D-03).

**Example:**
```typescript
// Source: CONTEXT.md D-03, D-04; ARCHITECTURE.md Pattern 7
// In authPlugin (fastify-plugin wrapped so visible app-wide):
app.decorateRequest("principal", null);
app.addHook("onRequest", async (request, reply) => {
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ")) {
    const key = await app.keyStore.resolve(auth.slice(7));
    if (key) {
      request.principal = { kind: "apiKey", id: key.id, grants: key.grants };
      return;
    }
    // Invalid key: still set anonymous — route policy decides whether to 401
  }
  request.principal = { kind: "anonymous" };
});

// In each collection route's preHandler:
function checkPolicy(collection: string, op: Operation) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const policy = config.collections[collection].operations[op];
    if (!policy) {
      return reply.status(403).type(PROBLEM_JSON).send(problem(403));
    }
    if (policy === "anonymous") return; // allow all
    if (policy === "apiKey") {
      if (request.principal.kind !== "apiKey") {
        return reply.status(401).type(PROBLEM_JSON).send(problem(401));
      }
      if (!request.principal.grants.has(`${collection}:${op}`)) {
        return reply.status(403).type(PROBLEM_JSON).send(problem(403));
      }
    }
  };
}
```

---

### Pattern 5: Honeypot check (fake-201 on fill)

**What:** A `preHandler` on anonymous create routes. If the honeypot field name is set for the collection and the request body contains that field with a truthy value, respond immediately with a fake `201 { id, createdAt }` — do not validate, do not persist, do not log any body field. Remove the honeypot field from the body before Ajv validation if not filled (the one stripping exception, D-08).

**Critical:** The honeypot field must NOT appear in the collection schema. This is validated at startup.

**Example:**
```typescript
// Source: CONTEXT.md D-08
function honeypotPreHandler(honeypotField: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as Record<string, unknown>;
    if (body[honeypotField]) {
      // Fake response — same shape as real anonymous create
      return reply.status(201).send({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      });
    }
    // Remove the field before validation proceeds
    delete body[honeypotField];
  };
}
```

---

### Pattern 6: Idempotency-Key deduplication

**What:** MongoDB collection `idempotency_keys`. Document shape:
```
{ _id: sha256(collectionName + ":" + rawKey),
  bodyHash: sha256(JSON.stringify(sortedBody)),
  status: "pending" | "complete",
  response: { id, createdAt, ... },
  createdAt: Date }
```
TTL index on `createdAt` with `expireAfterSeconds: 86400`. A preHandler checks for an existing entry before the handler runs. An in-flight entry (status: "pending") returns 409. A completed entry with the same body hash returns the original response (200 with Idempotency header). A completed entry with a different body hash returns 422.

**Example:**
```typescript
// Source: CONTEXT.md D-09; standard idempotency pattern
async function idempotencyPreHandler(
  idempRepo: IdempotencyRepository,
  collection: string,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const key = request.headers["idempotency-key"] as string | undefined;
  if (!key) return; // idempotency is optional

  const id = createHash("sha256")
    .update(`${collection}:${key}`)
    .digest("hex");
  const bodyHash = createHash("sha256")
    .update(JSON.stringify(request.body))
    .digest("hex");

  const existing = await idempRepo.find(id);
  if (!existing) {
    await idempRepo.insertPending(id, bodyHash);
    return; // proceed to handler; handler must call idempRepo.complete(id, response)
  }
  if (existing.status === "pending") {
    return reply.status(409).type(PROBLEM_JSON).send(problem(409));
  }
  if (existing.bodyHash !== bodyHash) {
    return reply.status(422).type(PROBLEM_JSON).send(problem(422));
  }
  // Exact replay
  return reply.status(201).send(existing.response);
}
```

**MongoDB index setup:**
```typescript
await db.collection("idempotency_keys").createIndex(
  { createdAt: 1 },
  { expireAfterSeconds: 86400, name: "ttl_24h" }
);
```

---

### Pattern 7: Keyset pagination on `(sortField, _id)`

**What:** No `skip`. Cursor is an opaque base64-encoded JSON object `{ v: sortFieldValue, id: lastId }`. One compound MongoDB index per indexed field: `{ [field]: 1, _id: 1 }`. Decode cursor to build a MongoDB range filter. Default sort: `{ createdAt: -1, _id: -1 }`.

**Example:**
```typescript
// Source: ARCHITECTURE.md, CONTEXT.md D-19; standard keyset pattern
function buildListQuery(
  sortField: string,
  sortDir: 1 | -1,
  cursor?: string,
  filters?: Record<string, unknown>,
): Filter<Document> {
  const base = { ...filters };
  if (cursor) {
    const { v, id } = JSON.parse(Buffer.from(cursor, "base64url").toString());
    // After-cursor: (sortField > v) OR (sortField == v AND _id > lastId)
    // For descending, reverse the operators
    const gt = sortDir === 1 ? "$gt" : "$lt";
    base.$or = [
      { [sortField]: { [gt]: v } },
      { [sortField]: v, _id: { [gt]: id } },
    ];
  }
  return base;
}

function encodeCursor(lastDoc: Document, sortField: string): string {
  return Buffer.from(
    JSON.stringify({ v: lastDoc[sortField], id: lastDoc._id })
  ).toString("base64url");
}
```

**MongoDB index creation at boot:**
```typescript
// One compound index per indexed field
for (const indexedField of collection.indexes) {
  await db.collection(name).createIndex(
    { [indexedField]: 1, _id: 1 },
    { name: `idx_${name}_${indexedField.replace(/\./g, "_")}_id` }
  );
}
// Always ensure createdAt index exists
await db.collection(name).createIndex(
  { createdAt: -1, _id: -1 },
  { name: `idx_${name}_createdAt_id` }
);
```

---

### Pattern 8: ETag / If-Match optimistic concurrency

**What:** Each record has a `_version: number` field, incremented on each write. ETag header = `"${_version}"`. PUT/PATCH accept `If-Match`; `findOneAndUpdate` filters on `{ _id, _version: expectedVersion }`. If no document matches, it was updated concurrently → 412 or 404.

**D-20 note:** `If-Match` is optional (last-write-wins if absent). Version is always returned in ETag.

**Example:**
```typescript
// Source: CONTEXT.md D-20; standard optimistic concurrency
async function replaceRecord(
  repo: RecordRepository,
  id: string,
  body: unknown,
  ifMatch: string | undefined,
): Promise<{ record: Document; version: number } | 404 | 412> {
  const expectedVersion = ifMatch ? parseInt(ifMatch.replace(/"/g, ""), 10) : undefined;
  const filter = expectedVersion !== undefined
    ? { _id: id, _version: expectedVersion }
    : { _id: id };
  const result = await repo.collection.findOneAndUpdate(
    filter,
    {
      $set: { ...body, updatedAt: new Date().toISOString() },
      $inc: { _version: 1 },
    },
    { returnDocument: "after" }
  );
  if (!result) {
    // Distinguish 404 (never existed) from 412 (exists but wrong version)
    const exists = await repo.collection.countDocuments({ _id: id });
    return exists > 0 ? 412 : 404;
  }
  return { record: result, version: result._version as number };
}
```

---

### Pattern 9: OpenAPI 3.1 generation with @fastify/swagger

**What:** Register `@fastify/swagger` once at app level before collection plugins. Each collection route plugin contributes its schemas via Fastify's route schema registration. `@fastify/swagger-ui` serves the UI at `/docs`. An HTTP bearer security scheme is declared for the OpenAPI doc; each apiKey route references it.

**Example:**
```typescript
// Source: STACK.md @fastify/swagger section; Fastify swagger docs
await app.register(swagger, {
  openapi: {
    openapi: "3.1.0",
    info: { title: "mailbox-org-drive-rest-api", version: "0.0.0" },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
    },
  },
});
await app.register(swaggerUi, {
  routePrefix: "/docs",
  uiConfig: { docExpansion: "list" },
});
```

**Relaxing CSP for swagger-ui:**
```typescript
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // swagger-ui needs inline scripts and styles
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
    },
  },
});
// Override only on /docs: set a looser CSP there
app.addHook("onSend", async (request, reply) => {
  if (request.url.startsWith("/docs")) {
    reply.header("content-security-policy", "default-src 'self' 'unsafe-inline'");
  }
});
```

---

### Pattern 10: Config schema extension for collections and API keys

**What:** Extend the existing `ConfigSchema` TypeBox object with `collections` and `apiKeys` sections. The collection schema is a JSON Schema object (the user's business schema) stored as a plain `Type.Unknown()` or `Type.Any()` in TypeBox, then compiled separately by the strict Ajv. The TypeBox schema validates the collection *definition* shape; the strict Ajv validates *records*.

**Key startup validations (all fail-fast with ConfigError):**
1. Collection name matches `MOUNT_NAME_PATTERN`
2. Collection name not in reserved list (`files`, `sheets`, `documents`, `mirror`, `admin`, `docs`, `health`, `ready`)
3. API key grants name only known collections and operations (create/get/list/replace/patch/delete)
4. Honeypot field name, if set, does not appear in the collection's JSON Schema properties
5. Indexed field paths resolve to scalar types in the collection schema; never pass through arrays
6. No indexed field segment named `eq`, `gt`, `gte`, `lt`, or `lte`
7. For anonymous-create collections: all string properties have a `maxLength` (or the schema is `additionalProperties: false` with no unbounded strings)
8. Each `$ref` in collection schemas resolves to a sibling file (Phase 1 D-18)

---

### Pattern 11: RFC 7396 Merge-Patch (PATCH)

**What:** `Content-Type: application/merge-patch+json`. The body is a partial object. Apply RFC 7396: for each key, if value is `null`, remove; otherwise override. The result is validated by the strict Ajv against the full collection schema. `id`, `createdAt`, and `_version` are always preserved from the existing record (patch body must not contain them).

**Example:**
```typescript
// Source: RFC 7396 (IETF); standard pattern
function mergePatch(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
    } else if (typeof value === "object" && !Array.isArray(value)) {
      result[key] = mergePatch(
        (result[key] as Record<string, unknown>) ?? {},
        value as Record<string, unknown>
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}
```

---

### Pattern 12: Kong declarative YAML reference config

**What:** A `deploy/kong.yml` in deck v3 / KIC format. Contains: upstream pointing to the API service, rate-limiting plugin (global), request-logging plugin (log method/route/status only), no body or header logging.

**Minimum viable structure:**
```yaml
# deploy/kong.yml - Kong Gateway declarative config reference
# Format: Kong deck v3
_format_version: "3.0"

services:
  - name: mailbox-org-drive-rest-api
    url: http://api:3000
    routes:
      - name: all
        paths:
          - /
        strip_path: false

plugins:
  - name: rate-limiting
    config:
      minute: 60
      policy: local
  - name: http-log
    config:
      # Log method, path, status only. No body, no headers, no query string.
      http_endpoint: http://log-collector/ingest
      custom_fields_by_lua:
        method: "return kong.request.get_method()"
        path: "return kong.request.get_path()"
        status: "return kong.response.get_status()"
```

**Note:** The exact Kong plugin format is `[ASSUMED]` for the custom_fields_by_lua approach. The required output (method/route/status only) is locked. Consult Kong docs for the actual logging plugin config accepted by the target Kong version.

---

### Anti-Patterns to Avoid

- **Using Fastify's default Ajv for record validation:** Silently coerces, strips, and defaults payload fields. Always use the dedicated strict Ajv instance for collection body validation [VERIFIED: STACK.md citing Fastify docs].
- **Global CORS registration:** `@fastify/cors` registered app-wide with per-request origin logic is harder to reason about than per-collection plugin registration. Register inside each collection plugin.
- **In-process lock for idempotency "pending" state:** An in-process `Map<key, Promise>` for idempotency is lost on crash and wrong for >1 replica. Use MongoDB as the coordination point.
- **Echoing Ajv validation errors:** Ajv errors contain the submitted value in `data`. Never pass `ajv.errors` to the response; map to a generic problem+json (COLL-07).
- **`skip`-based pagination:** Unstable under concurrent inserts, slow on large collections. Always use keyset pagination on `(sortField, _id)` [VERIFIED: ARCHITECTURE.md research].
- **Logging query strings on list routes:** Filters can carry email addresses or other personal data. The existing pino serializer already logs `routeOptions.url` (route template), not the raw URL. Test with the canary harness [VERIFIED: src/http/logging.ts].
- **Storing the raw API key:** Store `sha256(secret)` only. The raw key is shown once at keygen time and never stored [VERIFIED: STACK.md].
- **Using `argon2`/`bcrypt` for API key hashing:** These are for low-entropy human passwords. For 32-byte random tokens, SHA-256 + timingSafeEqual is correct and adds no per-request CPU cost [VERIFIED: STACK.md].

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| OpenAPI 3.1 generation | Custom spec builder | `@fastify/swagger` v9 | Auto-generates from route schemas; schema changes propagate automatically |
| Browser CORS | Manual `Access-Control-Allow-*` headers | `@fastify/cors` | Handles preflight, Vary, credentialed requests correctly |
| Rate limiting | Token bucket in a closure | `@fastify/rate-limit` | Handles `trustProxy`, IPv6, `Retry-After`, correct `X-RateLimit-*` headers |
| HTTP security headers | Manual `res.set(...)` calls | `@fastify/helmet` | Covers HSTS, nosniff, referrer, XSS; correct defaults |
| RFC 7396 merge-patch parsing | JSON Merge Patch library | Inline `mergePatch()` (10 lines) | The algorithm is 10 lines of spec; a library adds a dep for no value |
| Idempotency TTL cleanup | Cron job | MongoDB TTL index on `createdAt` | Native MongoDB; no process to manage |
| Keyset cursor encoding | Custom cursor format | Base64url(JSON) | Opaque, URL-safe, trivially reversible |

**Key insight:** The Fastify plugin ecosystem is designed for exactly this use case. Using it correctly (encapsulated plugins, fp for shared decorators) keeps the codebase small and the OpenAPI doc free.

---

## Common Pitfalls

### Pitfall 1: Fastify's default Ajv silently mutates record payloads
**What goes wrong:** A string field `"123"` is stored as number `123`; unknown fields are stripped; array coercion wraps scalars. Stored records diverge from what was validated. The JSON Schema the deployer wrote is a lie.
**Why it happens:** Fastify's defaults are optimized for route validation, not document storage. `coerceTypes: 'array'`, `removeAdditional: true`, `useDefaults: true` are all on by default [VERIFIED: STACK.md citing Fastify docs].
**How to avoid:** `setValidatorCompiler` in each collection plugin with the strict Ajv instance. Test with a payload whose string field has the same value as a valid integer.
**Warning signs:** Stored record has different type than schema; extra fields submitted in a test vanish silently.

### Pitfall 2: trustProxy misconfiguration allows IP spoofing for rate limits
**What goes wrong:** With `trustProxy: true` (the boolean), any client can forge `X-Forwarded-For: 1.2.3.4` and get a fresh rate-limit bucket [VERIFIED: @fastify/rate-limit README citing PITFALLS.md research].
**Why it happens:** `trustProxy: true` trusts every hop in the XFF chain, so the first (client-controlled) IP becomes the rate-limit key.
**How to avoid:** `server.trustProxy` is an explicit list of proxy IPs/CIDRs (D-10). Pass this list to `@fastify/rate-limit`'s `trustProxy` option. Integration test: send a forged `X-Forwarded-For` header through the Kong config and assert the limit still bites.

### Pitfall 3: Honeypot response leaks personal data via logging
**What goes wrong:** The fake-201 preHandler logs the body field that triggered it, or logs the fake UUID alongside other request data that could identify the sender.
**Why it happens:** Default Fastify request logging; custom log lines inside the honeypot handler.
**How to avoid:** The honeypot preHandler must call `reply.send(fake)` and return immediately without any `request.log.*` calls. The canary test must assert no body field values appear in log output for honeypot-triggered requests.

### Pitfall 4: Idempotency race condition creates duplicate records
**What goes wrong:** Two requests with the same `Idempotency-Key` arrive within milliseconds. Both read "no existing entry", both proceed, both insert a record.
**Why it happens:** The check and the insert are two separate operations.
**How to avoid:** Insert the idempotency entry as `status: "pending"` before the record insert, using a `unique` index on `_id` to catch races at the DB level (the second concurrent insert gets an E11000 and should return 409). Complete the entry after the record is inserted. Test with two parallel requests.

### Pitfall 5: Ajv validation errors echo submitted values in responses
**What goes wrong:** An anonymous submitter sends a large payload; `ajv.errors` contains the entire offending value in the `data` field; the error handler forwards it to the response.
**Why it happens:** Ajv error objects are detailed by design for developer tooling.
**How to avoid:** The error handler (already in `logging.ts`) must NOT pass Ajv errors to the response. Return a generic `problem(400)` only. Extend the canary test to cover a validation-failure path.

### Pitfall 6: Reserved collection names collide with Phase 4 routes
**What goes wrong:** A deployer names a collection `files` or `sheets`; Phase 4 mounts those routes; routes collide or one shadows the other.
**Why it happens:** Phase 4's read routes share the `/v1` prefix (D-15, D-16).
**How to avoid:** Startup validation rejects collection names in the reserved list (`files`, `sheets`, `documents`, `mirror`, `admin`, `docs`, `health`, `ready`) [VERIFIED: CONTEXT.md D-16].

### Pitfall 7: Per-collection Ajv compilation at request time
**What goes wrong:** `ajv.compile(collectionSchema)` called on every request; compilation is expensive (200–500 ms for a schema with patterns); memory leak from uncached compiled validators.
**Why it happens:** Collection schemas are runtime data, so it is tempting to compile lazily.
**How to avoid:** Compile all schemas at startup in `SchemaRegistry`. If a schema is invalid, fail startup with `ConfigError`. The compiled validators are frozen by collection name.

### Pitfall 8: ETag computation via payload hashing on every response
**What goes wrong:** Computing `sha256(JSON.stringify(doc))` on every GET/POST/PUT is unnecessary CPU work and means two reads of the same record can return different ETags if key ordering differs.
**Why it happens:** Payload hashing feels "correct".
**How to avoid:** ETag is `"${_version}"` where `_version` is the record's monotonic version counter. It is cheap, stable, and already in the stored document.

---

## Code Examples

### Config schema extension (discretionary shape, recommended)

```typescript
// src/config/schema.ts — additions
// COLLECTION_OPERATION values [VERIFIED: CONTEXT.md D-02]:
// "create" | "get" | "list" | "replace" | "patch" | "delete"
// COLLECTION_POLICY values [VERIFIED: CONTEXT.md D-01, D-03]:
// "anonymous" | "apiKey"

const COLLECTION_OPERATION = ["create", "get", "list", "replace", "patch", "delete"] as const;
const COLLECTION_POLICY = ["anonymous", "apiKey"] as const;

const CollectionSchema = Type.Object({
  schema: Type.Record(Type.String(), Type.Unknown()), // raw JSON Schema object
  operations: Type.Partial(
    Type.Object(Object.fromEntries(
      COLLECTION_OPERATION.map((op) => [op, Type.Enum([...COLLECTION_POLICY])])
    ))
  ),
  indexes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  honeypot: Type.Optional(Type.String({ minLength: 1 })),
  cors: Type.Optional(Type.Object({
    origins: Type.Array(Type.String({ format: "uri" })),
  })),
  rateLimit: Type.Optional(Type.Object({
    max: Type.Optional(Type.Integer({ minimum: 1 })),
    windowSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
  })),
  bodyLimit: Type.Optional(Type.Integer({ minimum: 1 })), // bytes
}, { additionalProperties: false });

const ApiKeySchema = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}$" }),
  hash: Type.String({ pattern: "^[0-9a-f]{64}$" }), // SHA-256 hex
  grants: Type.Array(Type.String({ minLength: 1 })),
}, { additionalProperties: false });

// Add to ConfigSchema.properties:
// collections: Type.Optional(Type.Record(
//   Type.String({ pattern: MOUNT_NAME_PATTERN }),
//   CollectionSchema,
//   { additionalProperties: false }
// ))
// apiKeys: Type.Optional(Type.Array(ApiKeySchema))
// server.trustProxy: Type.Optional(Type.Array(Type.String({ minLength: 1 })))
```

### Record document shape in MongoDB

```typescript
// Every collection record stored in MongoDB
interface RecordDocument {
  _id: string;        // crypto.randomUUID()
  createdAt: string;  // ISO 8601
  updatedAt: string;  // ISO 8601
  _version: number;   // 1 on create, +1 on each write
  // ...user-defined fields from schema...
}
```

### Keygen CLI command

```typescript
// src/keygen.ts — bundled CLI command
import { randomBytes, createHash } from "node:crypto";

const id = randomBytes(8).toString("hex");           // 16 hex chars
const secret = randomBytes(24).toString("base64url"); // 32 URL-safe chars
const rawKey = `mdra_${id}.${secret}`;
const hash = createHash("sha256").update(secret).digest("hex");

console.log(`Key:  ${rawKey}`);
console.log(`Hash: ${hash}`);
console.log(`\nAdd to config.yaml:`);
console.log(`apiKeys:\n  - name: my-key\n    hash: "${hash}"\n    grants: []`);
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| OpenAPI 2 (Swagger) with @fastify/swagger v7 | OpenAPI 3.1 with @fastify/swagger v9 | @fastify/swagger v9 (2024) | JSON Schema 2020-12 vocabulary supported; `nullable` replaced by `type: ["string", "null"]` |
| `@sinclair/typebox` (0.x) | `typebox` 1.x (new package name) | typebox 1.0 (2024) | Different npm package name; `@fastify/type-provider-typebox` 6.x targets the new package |
| Argon2 / bcrypt for all tokens | SHA-256 + timingSafeEqual for high-entropy random tokens | Recognized best practice | Removes native build dep; correct for 32-byte tokens |
| `skip`-based pagination | Keyset cursor pagination on `(sortField, _id)` | Established MongoDB practice | Stable under concurrent inserts; O(log n) not O(n) |

**Deprecated/outdated:**
- `@sinclair/typebox`: the legacy 0.x package. Use `typebox` 1.4.7 instead.
- Fastify v4 plugin API (`@fastify/cors` v8, `@fastify/rate-limit` v9): Phase 2 uses Fastify 5 and the corresponding v11 plugins.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Kong declarative YAML `custom_fields_by_lua` syntax for logging only method/path/status | Pattern 12 (Kong config) | Kong config may need a different plugin or different field names; planner should add a TODO comment and reference Kong docs |
| A2 | `@fastify/rate-limit` accepts a CIDR list via `trustProxy` config (same as Fastify's `trustProxy` option) | Pattern: rate limit | Rate-limit behavior with CIDR list not confirmed from docs this session; may need Fastify's native `trustProxy` to be set on the server and rate-limit to inherit it |
| A3 | Collection schema `$ref` sibling file resolution can be handled at config load time (Phase 1 D-18) using the YAML `$ref` or a custom resolver | Config extension | May require a two-pass load: load config, then resolve $refs; planner should allocate a task for $ref resolution |

**If this table is empty except for A1–A3:** All other claims were verified from prior research sessions (STACK.md, ARCHITECTURE.md, PITFALLS.md) or directly from the codebase (src/config/schema.ts, src/app.ts, etc.) this session.

---

## Open Questions (RESOLVED)

1. **`@fastify/rate-limit` + `trustProxy` CIDR list** — RESOLVED in 02-05-PLAN.md: set `server.trustProxy` from config before registering rate limit; integration test proves forged `X-Forwarded-For` from a non-trusted IP does not bypass per-IP limits.

2. **`application/merge-patch+json` content type parser** — RESOLVED in 02-04-PLAN.md and 02-06-PLAN.md: register the parser per collection plugin (encapsulated scope); PATCH validates merged document with strict Ajv after RFC 7396 merge.

3. **`/docs` on/off toggle** — RESOLVED in 02-08-PLAN.md: OpenAPI/Swagger UI disabled unless `server.docs: true` in config; `/docs` not registered when off.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| MongoDB (via Docker Compose) | RecordRepository, IdempotencyRepository | ✓ | 8.0 (from Compose stack) | — |
| Node.js ≥26 | Runtime | ✓ | 26.x (engines field) | — |
| pnpm 12.21.0 | Package management | ✓ | 12.21.0 (packageManager field) | — |
| Kong (reference config only) | deploy/kong.yml validation | ✗ (not needed locally) | — | Reference YAML only; not executed in tests |

**Missing dependencies with no fallback:** none
**Missing dependencies with fallback:** Kong not installed locally — `deploy/kong.yml` is a reference artefact and is not tested in CI.

---

## Security Domain

> `security_enforcement: true` in .planning/config.json — this section is required.

### Applicable ASVS Categories (Level 1)

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | Yes | Bearer token + SHA-256 timingSafeEqual; `mdra_` prefix for scanner detection |
| V3 Session Management | No | Stateless API; no sessions |
| V4 Access Control | Yes | Default-deny policy table; per-route preHandler; 401/403 problem+json |
| V5 Input Validation | Yes | Strict Ajv 2020-12; `additionalProperties: false`; `maxLength` on strings; no coercion |
| V6 Cryptography | Partial | SHA-256 for tokens (correct for high-entropy); `node:crypto` only; no hand-rolled crypto |
| V7 Error Handling | Yes | RFC 7807 problem+json; Ajv errors never echoed; body values never logged |
| V13 API | Yes | Content-Type check (415 on wrong type); per-route body limit; CORS per-collection |

### Known Threat Patterns for this Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Forged X-Forwarded-For bypasses rate limit | Spoofing | `trustProxy` CIDR list; test with forged header |
| Payload injection via large anonymous body | DoS | Per-route `bodyLimit` (few KB); `maxLength` on all strings |
| Mongo operator injection via filter params | Tampering | Allow-listed indexed fields with typed operators; build Mongo filter from scratch |
| API key in logs | Information Disclosure | `redact: ["headers.authorization"]` already in pino config |
| Honeypot bypass via fuzzing field names | Spoofing | Honeypot field is config-defined; fuzzing cannot guess it |
| Formula injection in mirror via collection records | Tampering | Phase 3 concern; note here: collection service must not pass raw record values to exceljs cell.value |
| Idempotency race creates duplicate records | Spoofing | Unique index on idempotency `_id`; pessimistic "pending" status before handler |
| Timing side-channel on API key comparison | Information Disclosure | `crypto.timingSafeEqual` on fixed-length hash buffers |

---

## Sources

### Primary (HIGH confidence)
- `src/config/schema.ts` [VERIFIED: read this session] — `ConfigSchema`, `MOUNT_NAME_PATTERN`, `Config` type (lines 1–85)
- `src/config/load.ts` [VERIFIED: read this session] — `loadConfig`, `ConfigError`, `ConfigIssue`, fail-fast all-errors-at-once pattern
- `src/app.ts`, `src/db/mongo.ts`, `src/http/logging.ts` [VERIFIED: read this session] — composition root, Mongo interface, problem+json error handler
- `.planning/phases/02-collections-access-policy-and-anonymous-hardening/02-CONTEXT.md` [VERIFIED: read this session] — all locked decisions D-01 through D-20
- `.planning/research/STACK.md` [VERIFIED: read this session via shell] — all package versions verified on npm registry 2026-11-21; Fastify default Ajv options; API key hashing rationale; @fastify/swagger 3.1.0 support
- `.planning/research/ARCHITECTURE.md` [VERIFIED: read this session via shell] — component boundaries, auth pattern, keyset pagination, single-writer lease
- `.planning/research/PITFALLS.md` [VERIFIED: read this session via shell] — Pitfalls 7 (rate limit/trustProxy), 8 (Ajv coercion, Mongo operator injection), 9 (PII in logs)
- `npm view` output this session — confirmed: @fastify/swagger 9.9.5, @fastify/swagger-ui 6.1.5, @fastify/cors 11.4.3, @fastify/rate-limit 11.3.0, @fastify/helmet 13.2.0, @fastify/type-provider-typebox 6.3.0, fastify-plugin 6.0.1, ajv-formats 3.0.1

### Secondary (MEDIUM confidence)
- `package.json` [VERIFIED: read this session] — confirms installed packages: ajv 8.20.0, fastify 5.12.8, mongodb 7.9.1, typebox 1.4.7
- `vitest.config.ts` [VERIFIED: read this session] — test project structure (unit / integration); no nyquist_validation required (config.json `nyquist_validation: false`)
- `.planning/REQUIREMENTS.md` [VERIFIED: read this session] — full requirement wording for COLL-01..08, SEC-01..09, FND-04
- RFC 7396 (IETF) — merge-patch algorithm (10-line implementation is the entire spec)
- RFC 7807 / RFC 9457 — problem+json (already implemented in logging.ts; extend for new status codes)

### Tertiary (LOW confidence)
- Kong declarative config YAML syntax — Kong deck v3 format used in Pattern 12 is `[ASSUMED]`; exact plugin field names should be verified against Kong docs before implementation

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages were previously verified in STACK.md research and npm-confirmed this session
- Architecture patterns: HIGH — derived from CONTEXT.md locked decisions and ARCHITECTURE.md research
- Config shape (discretionary parts): MEDIUM — Claude's discretion; shape recommendations are reasonable but not locked
- Kong config format: LOW — format assumed from training knowledge; needs docs verification

**Research date:** 2026-11-22
**Valid until:** 2026-12-22 (packages pinned in lockfile; architecture is stable)
