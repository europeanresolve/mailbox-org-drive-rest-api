# Architecture Patterns

**Domain:** Self-hosted REST facade over a WebDAV drive (mailbox.org / OX App Suite) with a MongoDB system of record, a one-way `.xlsx` mirror, and an ETag-keyed read cache
**Researched:** 2026-11-21
**Overall confidence:** MEDIUM-HIGH. The structure follows well-known patterns (ports and adapters, lease-based single writer, stale-while-revalidate). OX-specific WebDAV behaviour (MOVE atomicity, ETag stability, versioning) is unverified and needs the phase-1 spike.

## Recommended Architecture

One Node process, one container image, two logical roles that share code: an **HTTP role** (Fastify) and a **worker role** (mirror worker plus cache revalidation). By default one process runs both (`ROLE=all`). `ROLE=api` and `ROLE=worker` exist from day one so the roles can be split later without code changes. MongoDB is the only coordination point. There is no Redis and no queue broker.

Dependency direction is strictly inward. Fastify routes call services. Services call repositories and the `StorageAdapter` port. Nothing below the HTTP layer imports Fastify.

```
                         +--------------------------- HTTP role (Fastify) -----------------------------+
 website / tools  --->   | routes (collections | sheets | documents | files | health | docs)            |
                         |   preHandler: authenticate -> authorize(policy)  (default deny)              |
                         +---------+---------------------+---------------------+-----------------------+
                                   |                     |                     |
                         CollectionService        ContentService (sheets/docs)   FileService
                          |    |      |             |            |                  |
              SchemaRegistry |  MirrorState     ContentCache   Converters         PathGuard+Mounts
              (Ajv, columns) |  .markDirty()    (SWR, single-   (pure fns:             |
                             |      |            flight)         xlsx->rows,           |
                       RecordRepo   |              |             docx->md)             |
                             |      |              |   |                               |
                          +--v------v--------------v---v--+                            |
                          |          MongoDB              |                            |
                          | records | mirror_state | leases | content_cache | api_keys |
                          +--^------^-----------------^---+                            |
                             |      |                 |                                |
        +--------------------+------+-----------------+--------------------------------+---+
        |                 worker role                                                       |
        |  MirrorWorker: poll mirror_state -> acquire lease -> snapshot records -> build    |
        |                .xlsx -> PUT temp -> MOVE over final -> commit mirroredSeq         |
        |  Reconciler:   boot sweep + periodic "mark all dirty", orphan temp cleanup        |
        +------------------------------------+-----------------------------------------------+
                                             |
                                   StorageAdapter (port)
                                   |-- WebDavAdapter (undici/webdav client, retry, limiter)
                                   `-- MemoryAdapter / FsAdapter (unit tests, contract-tested)
                                             |
                                   mailbox.org Drive (WebDAV)
```

### Component Boundaries

| Component | Responsibility | Communicates With | Must not |
|-----------|---------------|-------------------|----------|
| **Config loader** | Parse file + env, validate against a schema, produce one frozen typed `Config`; fail fast with all errors listed | Everything receives `Config` by injection at composition root | Be read lazily from `process.env` elsewhere; log secrets |
| **Composition root** (`main.ts`) | Build config, Mongo client, adapter, registries, services; start roles | All | Contain business logic |
| **Mounts + PathGuard** | Map `mountName + relPath` to an absolute Drive path; enforce mode (`read` / `read-write`); reject `..`, encoded traversal (`%2e%2e`, `%2f`), backslashes, NUL, absolute paths, double-decoding | StorageAdapter callers (Sheet/Doc/File services, MirrorWorker) | Be bypassable: the adapter must accept only guard-produced `ResolvedPath` values (branded type) |
| **StorageAdapter** (port) | `list`, `stat` (etag, lastModified, size), `read` (stream), `write` (stream/buffer), `mkdir`, `move`, `delete`. Uniform error taxonomy: `NotFound`, `Conflict`, `Unavailable`, `RateLimited` | WebDavAdapter, test fakes | Know about mounts, collections or Mongo |
| **WebDavAdapter** | HTTP/WebDAV mapping, PROPFIND parsing, path encoding quirks (`Userstore/Last, First`), retry with exponential backoff and jitter on 429/503/network, concurrency cap (2 to 4), per-request timeout | Drive | Be used on the hot read path directly |
| **Mongo repositories** | One repo per collection of documents: `RecordRepo`, `MirrorStateRepo`, `LeaseRepo`, `CacheRepo`, `ApiKeyRepo`. Index creation at boot. All queries live here | MongoDB | Leak driver types upward; skip the tombstone filter |
| **Schema registry** | Compile each collection's JSON Schema once at boot with a strict Ajv instance; derive mirror columns; expose indexed-filter whitelist | CollectionService, MirrorWorker, OpenAPI builder | Reload at runtime (restart to change; see Open Decisions) |
| **CollectionService** | Validate (full doc for create/replace; merge-then-validate for patch), assign UUID and `createdAt` / `updatedAt`, persist, then bump mirror dirty counter | RecordRepo, SchemaRegistry, MirrorStateRepo | Talk to the Drive; know about HTTP |
| **Auth policy layer** | Resolve a principal (`anonymous` or `apiKey` id) and answer `allow(principal, collection, operation)`. Default deny. Data-driven from collection config | Fastify hooks, ApiKeyRepo / config key store | Embed role logic (OIDC/RBAC arrives in v2.0 behind the same `Principal` + `allow()` seam) |
| **MirrorWorker** | Debounced, lease-guarded regeneration of one `.xlsx` per collection (see below) | MirrorStateRepo, LeaseRepo, RecordRepo, SchemaRegistry, StorageAdapter | Run inside a request; hold records in memory beyond one build |
| **ContentCache** | Read-through cache for parsed sheets and converted docs, keyed on mount path, validated by Drive ETag (see below) | CacheRepo, StorageAdapter, Converters | Block a request on the Drive when a usable entry exists |
| **Converters** | Pure functions: xlsx buffer to rows (exceljs), docx buffer to Markdown (mammoth then turndown). Versioned (`parserVersion`) | ContentCache | Do IO |
| **HTTP layer** | Route plugins, error mapper (domain error to RFC 9457-style problem JSON), `@fastify/swagger` OpenAPI at `/docs`, `/health`, `/ready`, pino request logging with redaction, `@fastify/rate-limit` fallback | Services, policy layer | Contain domain logic |

### Data Flow

**Write path (first priority).** Direction: client to Mongo, then asynchronously to Drive. The request never waits for the Drive.

```
POST /collections/:name/records
 1. route: authenticate (anonymous | apiKey) -> authorize(principal, collection, "create")
 2. route: per-collection bodyLimit, rate limit
 3. CollectionService.create: strict Ajv validate -> add id/createdAt/updatedAt
 4. RecordRepo.insert                                   (record durable; 201 returned after step 5)
 5. MirrorStateRepo.markDirty(collection)               ($inc dirtySeq, $set dueAt = now + debounce)
 6. respond 201

 ... later, worker tick (every 5-10 s) ...
 7. find mirror_state where dirtySeq > mirroredSeq AND dueAt <= now AND nextAttemptAt <= now
 8. LeaseRepo.acquire("mirror:<collection>")            (fails -> another instance owns it, skip)
 9. seq = dirtySeq (read first); stream RecordRepo cursor (tombstones excluded) -> exceljs
10. adapter.write(<name>.xlsx.<token>.tmp); adapter.move(tmp -> <name>.xlsx, overwrite)
11. MirrorStateRepo.commit(mirroredSeq = seq) only if lease token still mine
12. release lease; on failure: failures++, nextAttemptAt = backoff, lastError (no PII)
```

Why "dirty counter in Mongo" instead of an in-process timer: the debounce survives restarts and rolling deploys, and any replica can pick the work up. A timer-only design loses pending mirrors on crash and needs a reconcile pass anyway.

Step 4 and 5 are two writes without a transaction (a standalone Mongo has none, and FerretDB compatibility is wanted). A crash between them leaves a record that is not yet mirrored. The Reconciler closes this gap: on boot and every N minutes (default 15) it marks every collection dirty. At tens of writes per week a full regeneration is trivially cheap and the operation is idempotent.

**Read path for Sheets and Documents.** Direction: Mongo cache to client on the hot path; Drive only in the background.

```
GET /sheets/:mount/*path
 1. route: authorize; PathGuard.resolve(mount, path)  (400/403 before any IO)
 2. ContentCache.get(key = "<mount>:<path>")
    a. HIT, fresh   (now - checkedAt < ttl)             -> serve; no Drive call
    b. HIT, stale   (ttl <= age < maxStale)             -> serve stale + trigger background revalidate
    c. HIT, too old (age >= maxStale) or MISS           -> single-flight blocking fetch, then serve
 3. respond with ETag = hash(driveEtag + parserVersion), Cache-Control, 304 on If-None-Match

Background revalidate (single-flight per key, in-process Map<key, Promise>):
 r1. adapter.stat(path)  (PROPFIND Depth:0; never Depth:1/infinity on this path)
 r2. etag unchanged  -> updateOne({checkedAt: now, failures: 0})        (no download, no parse)
 r3. etag changed    -> adapter.read -> Converters -> upsert {etag, payload, parsedAt, checkedAt}
 r4. Drive error     -> keep entry, failures++, nextCheckAt = backoff   (stale-if-error)
 r5. 404 on Drive    -> mark entry gone; serve 404 after maxStale, not instantly
```

Sheets and documents use the same `ContentCache`; they differ only in the `Converter` plugged in. Files (list and download) are not cached in Mongo: listing may use the same stat/list TTL entry, and downloads stream through the adapter with `ETag` pass-through and a size cap.

## Patterns to Follow

### Pattern 1: Ports and adapters around the Drive
**What:** `StorageAdapter` is the only thing that knows WebDAV. Ship a `MemoryAdapter` next to the `WebDavAdapter`, and one shared contract test suite that both must pass.
**When:** Always. It gives the S3 exit path and makes the mirror and cache unit-testable without Docker.
**Example:**
```typescript
export interface StorageAdapter {
  stat(p: ResolvedPath): Promise<{ etag: string; lastModified: Date; size: number; isDir: boolean }>;
  list(p: ResolvedPath): Promise<StatEntry[]>;
  read(p: ResolvedPath): Promise<Readable>;
  write(p: ResolvedPath, body: Buffer | Readable, opts?: { ifMatch?: string }): Promise<void>;
  mkdir(p: ResolvedPath): Promise<void>;
  move(from: ResolvedPath, to: ResolvedPath, opts: { overwrite: boolean }): Promise<void>;
  delete(p: ResolvedPath): Promise<void>;
}
```
`ResolvedPath` is a branded string only `PathGuard` can produce, so path traversal cannot be reintroduced by a new call site.

### Pattern 2: Single writer by Mongo lease, with a fencing token
**What:** One lease document per collection in a `leases` collection. Acquire with an atomic `findOneAndUpdate`:
```typescript
// acquire if free, expired, or already mine; $inc gives a monotonically increasing fencing token
const r = await leases.findOneAndUpdate(
  { _id: `mirror:${name}`, $or: [{ expiresAt: { $lt: now } }, { owner: me }] },
  { $set: { owner: me, expiresAt: new Date(now.getTime() + ttlMs) }, $inc: { token: 1 } },
  { upsert: true, returnDocument: "after" },
); // catch E11000 duplicate key on the upsert race => someone else holds it
```
Heartbeat every `ttl/3` (ttl 60 s) while a run is in progress. Commit `mirroredSeq` with a filter on the lease token so a zombie holder cannot record success.
**When:** Always, even if you plan a single replica. Rolling deploys and `docker compose up` on a new image briefly run two processes; an in-process lock does not protect against that.
**Why not in-process only:** correct for exactly one process, wrong during every deploy overlap. The lease is about 40 lines and needs no new infrastructure.
**Why not Redis/Redlock or a message queue:** adds a service to a "single image plus MongoDB" product for a workload of tens of writes a week.
**Honest limit:** WebDAV offers no fencing. A zombie that passed its lease check could still upload an older snapshot after the new owner. This self-heals because every run regenerates from the current Mongo state and the dirty counter or the reconcile sweep triggers another run. Check the lease immediately before the MOVE to narrow the window. Do not rely on WebDAV LOCK: OX behaviour is unknown and the lock would not survive a crashed holder anyway.

### Pattern 3: Durable debounce in `mirror_state`
**What:** One document per collection: `{ _id, dirtySeq, mirroredSeq, dueAt, failures, nextAttemptAt, lastError, lastMirroredAt }`. Writers `$inc` and push `dueAt` forward. The worker polls.
**When:** Always. Debounce window 10 to 30 s (configurable). A max-wait cap against starvation is unnecessary at this write volume. Leave a `shortcut:` comment.
**Result:** "mirror lag" is `dirtySeq - mirroredSeq` and `now - lastMirroredAt`, which is cheap to expose in `/ready` details and logs.

### Pattern 4: Atomic mirror write via temp name plus MOVE
**What:** Build the workbook fully in memory (or a temp file above a size threshold), `PUT` to `.<name>.xlsx.<random>.tmp` in the same folder, then `MOVE` with `Overwrite: T` onto `<name>.xlsx`. Same folder keeps the MOVE a rename, not a cross-collection copy. On boot, delete orphaned `*.tmp` files older than an hour.
**Caveats (spike in phase 1):** whether OX performs MOVE-over-existing atomically; whether it creates a new version or a trash entry for the overwritten file; whether the file ID or share links survive. Build the worker so the commit step is one `adapter.move()` call and can be swapped for plain `PUT` to the final name if MOVE misbehaves.
**Content:** regenerate the whole file every time (no incremental edits). Columns come from the schema (or config mapping) plus `id`, `createdAt`, `updatedAt`. Cell values are written as typed strings or numbers, never as formulas.

### Pattern 5: Stale-while-revalidate with ETag validation and single-flight
**What:** A cache entry stores `{ etag, lastModified, size, payload, parserVersion, parsedAt, checkedAt, failures, nextCheckAt }`. `ttl` (default 5 min) controls when to re-check; the ETag decides whether to re-download. `maxStale` (suggest 1 h) bounds how old an entry may be served when no one has revalidated, so a quiet site does not serve day-old content.
**Single-flight:** an in-process `Map<key, Promise>`. Across replicas duplicate revalidation is harmless (idempotent upsert guarded by `etag`), so no distributed lock is needed.
**Separate metadata from payload:** keep `payload` in a field excluded by projection on freshness checks, or in a sibling collection, so a `304` and an "unchanged" re-check never read a large document.
**On-demand only:** revalidate on request, not on a timer. A timer polls Drive for content nobody reads and multiplies load on a provider with undocumented limits.
**Parser version bump:** `parserVersion` is part of the stored entry and the served ETag, so changing the converter invalidates cached output without touching the Drive.

### Pattern 6: Strict validation lives in the service, not in Fastify defaults
**What:** Fastify's default Ajv runs with `coerceTypes: 'array'`, `useDefaults: true` and `removeAdditional: true` (verified in the Fastify validation docs). For anonymous form endpoints that silently rewrites payloads (a string `"1"` becomes a number, extra properties vanish). Create one dedicated Ajv with `coerceTypes: false`, `removeAdditional: false`, `useDefaults: false`, `allErrors: false` and use it for all record validation, and set it as the app-wide `setValidatorCompiler`.
**When:** Always. Compile each collection schema once at boot (registry), not per request.
**OpenAPI:** register collection routes per collection at boot (a loop in the route plugin) so each route carries its real schema, per-collection `bodyLimit` and per-collection policy. `@fastify/swagger` then documents them without hand-written specs. For `PATCH`, document a generic object and validate the merged record in the service.

### Pattern 7: Principal plus policy table, default deny
**What:** An `onRequest` hook resolves a `Principal` (`{ kind: "anonymous" }` or `{ kind: "apiKey", id }`). Keys are random 32-byte values stored as SHA-256 hashes, compared in constant time; a slow KDF is unnecessary for high-entropy keys. A per-route preHandler calls `policy.allow(principal, collection, op)`. The policy table comes from collection config (`create: anonymous`, `read: apiKey`, ...). Anything not listed is denied.
**Key storage:** hide it behind a `KeyStore` interface (`config` implementation first; `mongo` implementation when rotation endpoints are wanted). This keeps the open question cheap to answer later.

### Pattern 8: Readiness reflects what can actually be served
**What:** `/health` is liveness only (no dependencies). `/ready` pings MongoDB and reports mirror lag and last successful Drive contact as informational fields. It does **not** fail when the Drive is down: writes go to Mongo and reads come from cache, so the service is still useful, and an orchestrator that restarts the container on a Drive outage makes things worse.

## Anti-Patterns to Avoid

### Anti-Pattern 1: Writing to the Drive inside the request
**What:** Calling `adapter.write` from the POST handler "to keep the mirror fresh".
**Why bad:** Makes the website form depend on Drive availability and latency; creates concurrent writers; amplifies load on a provider with no published limits.
**Instead:** Request writes Mongo and bumps `dirtySeq`; only the worker touches the mirror.

### Anti-Pattern 2: Reading the Drive on the hot path
**What:** `stat`/`PROPFIND` per incoming request "to be sure it is fresh".
**Why bad:** One website visit equals one Drive round trip; hits rate limits; breaks the "no Drive on the hot path" requirement.
**Instead:** Serve from cache; revalidate in the background at most once per `ttl` per key.

### Anti-Pattern 3: In-process timers as the source of truth for pending mirrors
**What:** `setTimeout` debounce holding the only record that work is pending.
**Why bad:** Lost on crash or deploy; two replicas each run their own timer.
**Instead:** Durable dirty state in Mongo; the timer is just a poll loop.

### Anti-Pattern 4: Treating the mirror as input
**What:** Reading the mirrored `.xlsx` back, or exposing it through the Sheets endpoint.
**Why bad:** Re-introduces the sync-back problem that is explicitly out of scope; a staff edit would be silently overwritten by the next regeneration.
**Instead:** Mirror folder is a write-only concern of the worker. Document it as read-only by convention. Config validation rejects a Sheets mount that overlaps a mirror folder.

### Anti-Pattern 5: Path checks scattered across handlers
**What:** Each route sanitising its own path.
**Why bad:** One miss is a traversal bug on a service that holds Drive credentials.
**Instead:** Single `PathGuard`, branded `ResolvedPath` type, adapter accepts nothing else. Property-based tests on the guard.

### Anti-Pattern 6: Putting the whole Drive file in one Mongo document unbounded
**What:** Caching a parsed sheet or Markdown doc without a size ceiling.
**Why bad:** 16 MB BSON document limit; large `.xlsx` parses block the event loop and blow memory.
**Instead:** Enforce `maxBytes` on read from Drive (config, per mount), reject or stream oversize files, and store parsed rows in GridFS or chunked documents only if a real use case appears. If parsing causes event-loop lag, move converters to `worker_threads` (for example via piscina). Do not do this preemptively.

### Anti-Pattern 7: Logging record contents
**What:** Logging request bodies or validation error values.
**Why bad:** Records are personal data; AJV error output can echo values.
**Instead:** pino `redact` plus a serializer that logs only schema path and keyword of validation errors, never `data`.

## Scalability Considerations

The target is tens of writes a week and read-heavy website traffic from cache. The design is sized for correctness, not throughput.

| Concern | One instance (expected) | A few API replicas | Heavy read traffic |
|---------|-------------------------|--------------------|--------------------|
| Mirror single writer | Lease still used; costs nothing | Lease picks one owner per collection; others skip | Unchanged |
| Cache revalidation | In-process single-flight | Duplicate checks per replica are harmless; at most `replicas` PROPFINDs per key per TTL | Put a CDN or Kong cache in front; add a small in-process LRU for hot payloads if Mongo reads show up in profiles |
| Rate limiting | `@fastify/rate-limit` in memory | Per-replica counters (effective limit multiplies); use Kong or the plugin's Mongo/Redis store only if needed | Edge limiter (Kong reference config) |
| Mongo | Single node, standalone is enough | Same; no transactions required by the design | Index on cache `_id`, record filter fields only |
| Drive load | Roughly one PUT + one MOVE per debounced batch; one PROPFIND per read key per TTL | Same plus lease-gated writes | Unchanged, because reads never reach the Drive directly |
| Mirror size | Hundreds to thousands of rows | Same | Excel limit is 1,048,576 rows per sheet; fail the mirror (not the API) with a clear `lastError` beyond that |

## Suggested Build Order

Delivery rule from the user: the **forms write path (collections plus `.xlsx` mirror) ships before any read-only content**. Dependencies decide the rest.

```
Config + logging + Compose stack + CI
        |
        +--> Mounts/PathGuard --> StorageAdapter (WebDAV + Memory) --+
        |                                                            |
        +--> Mongo repos + SchemaRegistry --> CollectionService      |
                       |                          |                  |
                  Auth policy --> Collection HTTP routes             |
                                        |                            |
                                        +--> MirrorState.markDirty --+--> MirrorWorker (lease, build, atomic write)
                                                                           |
                                         ===== write path complete =========
                                                                           |
                        ContentCache --> Sheets --> Documents --> Files
                                                                           |
                                                         HTTP caching polish, Kong ref config, docs
```

1. **Foundations and spike.** Config loader (fail fast), pino with redaction, Fastify skeleton with `/health` and `/ready`, Docker Compose (MongoDB plus a local WebDAV server), CI (lint, typecheck, unit, integration, image). In parallel run the OX WebDAV spike (MOVE-over-existing behaviour, ETag stability, versioning and trash, folder path encoding) against a throwaway account, and record results as facts the adapter contract tests encode. Nothing else can be trusted until this exists.
2. **Mounts, PathGuard and StorageAdapter.** Needed by the mirror (write, mkdir, move) and later by everything that reads. Build `MemoryAdapter` first, then `WebDavAdapter` against the Compose WebDAV server, both under one contract suite. Include retry and backoff and the concurrency cap here, not later.
3. **Collections core.** Mongo connection and index bootstrap, `SchemaRegistry` with the strict Ajv, `RecordRepo`, `CollectionService`, CRUD routes (create, list with pagination and indexed filters, get, replace, patch, delete), problem-JSON error mapper, OpenAPI emission. Decide soft vs hard delete here because it changes the repo filter and the mirror query. Steps 2 and 3 are independent and can proceed in parallel.
4. **Access policies and anonymous hardening.** Principal resolution, policy table, hashed API keys, per-route `bodyLimit`, rate limit fallback, schema strictness defaults for anonymous collections. Must land before the write path is considered shippable, because anonymous POST is the first public surface. It is a separate step from 3 only to keep CRUD testable without auth; routes should be registered through the policy wrapper from the first commit (default deny).
5. **Mirror worker.** `mirror_state` and `markDirty` wired into `CollectionService`, lease repo, column derivation, workbook builder, temp-then-MOVE write, backoff, reconciler, orphan-temp cleanup, mirror lag in `/ready`. Depends on 2 and 3. **Milestone: forms write path done.**
6. **ContentCache plus Sheets.** The cache and SWR logic is the hard part; Sheets is its simplest consumer (rows from the header row, ETag out). Depends on 2 only, so it can start earlier if capacity allows, but ordering is a priority choice, not a technical one.
7. **Documents.** Add the docx converter (mammoth, turndown, image drop or inline config) on the existing cache. Pure addition.
8. **Files.** List and streamed download from read mounts. Touches PathGuard and the adapter only.
9. **HTTP caching and deployment polish.** `ETag`/`Cache-Control`/304 on all read endpoints (a skeleton exists since step 6), Kong reference config in `deploy/`, README and operations notes (mirror lag, TTL tuning, Drive limits).

**Build-order implications for roadmap:**
- Steps 1 to 5 form one coherent first milestone phase group; do not interleave read-only content into it.
- `ROLE=api|worker|all` and the lease should exist from step 5 even if only `all` is used.
- The Memory adapter and contract tests in step 2 pay off in 5, 6, 7 and 8; do not skip them.
- OpenAPI should grow with each route, not be a final task; the per-collection route loop in step 3 is what makes this cheap.

## Open Decisions (recommendations)

| Question from PROJECT.md | Recommendation | Reason |
|--------------------------|----------------|--------|
| Collection definitions: config vs admin endpoints | **Config only** for v1, loaded at boot | No admin auth surface; schemas versioned with the deployment; `SchemaRegistry` source can become pluggable later |
| API keys: config vs Mongo | **Config (hashed)** first behind a `KeyStore` interface | Fewer moving parts; rotation endpoints belong with v2.0 auth work |
| Mirror layout: one workbook per collection vs one with a sheet per collection | **One workbook per collection, one worksheet** | Independent leases and failure domains; a bad collection cannot block the others; simpler MOVE and size reasoning |
| Soft delete vs hard delete | **Hard delete by default** (tombstone optional per collection later) | Records are personal data and GDPR erasure is v2.0; tombstones keep personal data. If tombstones are chosen, the repo must filter them centrally and erasure must purge them |
| Debounce implementation | Durable dirty counter plus poll loop | See Pattern 3 |

## Confidence Notes

| Claim | Confidence | Basis |
|-------|------------|-------|
| Fastify default Ajv options coerce and strip | HIGH | Fastify validation docs, fetched 2026-11-21 |
| Mongo lease via atomic `findOneAndUpdate` on a standalone server | HIGH | Single-document atomicity is a core Mongo guarantee; pattern is standard |
| FerretDB compatibility of the lease and update operators used | LOW | Not verified; test in CI before promising FerretDB support. Avoid TTL indexes and pipeline updates for correctness |
| OX MOVE-over-existing is atomic, version and trash behaviour | LOW | Unknown; spike required |
| OX ETag stability across reads and rewrites | LOW | Unknown; the cache design degrades safely to `lastModified + size` if ETags are unstable |
| SWR with `maxStale` and on-demand revalidation | HIGH | Standard HTTP caching semantics (RFC 5861) applied at the application layer |
| Excel cells written as typed strings are not evaluated as formulas on open | MEDIUM | Standard xlsx cell typing; still add an optional leading-apostrophe guard for values starting with `=`, `+`, `-`, `@` because staff may export to CSV |

## Sources

- Fastify Validation and Serialization reference, https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/ (default Ajv options, `setValidatorCompiler`, per-route `validatorCompiler`) - HIGH
- Project context: `.planning/PROJECT.md` and `PROJECT-BRIEF.md` (constraints, volumes, OX unknowns) - HIGH for requirements
- Standard patterns from general engineering practice, not tied to a single source: ports and adapters, lease with fencing token, RFC 5861 `stale-while-revalidate` / `stale-if-error`, WebDAV (RFC 4918) PROPFIND Depth 0 and MOVE with `Overwrite` - MEDIUM (not re-fetched this session)
