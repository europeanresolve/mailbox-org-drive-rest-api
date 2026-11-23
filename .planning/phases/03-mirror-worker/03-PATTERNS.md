# Phase 03: Mirror Worker — Pattern Map

**Mapped:** 2026-11-22
**Files analyzed:** 15 new/modified files
**Analogs found:** 15 / 15

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/mirror/worker.ts` | service (background loop) | event-driven + poll | `src/collections/store.ts` (Mongo patterns), `src/server.ts` (lifecycle) | role-match |
| `src/mirror/workbook.ts` | utility (pure transform) | transform | `src/collections/idempotency.ts` (`canonicalHash` + hash pattern) | partial-match |
| `src/mirror/state.ts` | model (Mongo CRUD) | CRUD | `src/collections/store.ts` | exact |
| `src/mirror/lease.ts` | utility (Mongo atomic op) | CRUD | `src/collections/idempotency.ts` (`isDuplicateKey`, E11000 handling, `findOneAndUpdate` upsert) | role-match |
| `src/mirror/path.ts` | utility (pure transform) | transform | `src/storage/drive-path.ts` | role-match |
| `src/mirror/routes.ts` | controller (operator routes) | request-response | `src/http/health.ts` | role-match |
| `src/collections/routes.ts` | controller (CHANGE: dirty-mark) | CRUD | self | exact |
| `src/config/schema.ts` | config (CHANGE: mirror + nested names) | — | self | exact |
| `src/config/load.ts` | config (CHANGE: mirror validation) | — | self | exact |
| `src/collections/definition.ts` | config (CHANGE: slash names, operator grants) | — | self | exact |
| `src/app.ts` | config (CHANGE: mirror option, operator routes) | — | self | exact |
| `src/server.ts` | config (CHANGE: ROLE, worker lifecycle) | — | self | exact |
| `src/http/health.ts` | controller (CHANGE: mirror lag) | request-response | self | exact |
| `test/helpers/collections-app.ts` | test (CHANGE: extend for mirror) | — | self | exact |
| `test/integration/mirror-lease.test.ts` | test (new: two-instance) | event-driven | `test/integration/collections.test.ts` | role-match |

---

## Pattern Assignments

### `src/mirror/state.ts` (model, CRUD)

**Analog:** `src/collections/store.ts`

**Imports pattern** (lines 1–4):
```typescript
import type { Db } from "mongodb";
```

**Core pattern** (lines 11–22, `store.ts`):
```typescript
// Class wraps a Db; one private method returns the named collection
export class RecordStore {
  readonly #db: Db;
  constructor(db: Db) { this.#db = db; }
  #records(name: string) {
    return this.#db.collection<RecordDocument>(`records_${name}`);
  }
}
```
→ For `state.ts`: use `this.#db.collection<MirrorState>("mirror_state")` and `this.#db.collection("leases")`.

**Atomic update pattern** (lines 55–72, `store.ts`):
```typescript
return this.#records(name).findOneAndUpdate(
  filter,
  {
    $set: { data, updatedAt: new Date().toISOString() },
    $inc: { _v: 1 },
  },
  { returnDocument: "after" },
);
```
→ For `markDirty`: use `$inc: { dirtySeq: 1 }, $max: { dueAt }` with `upsert: true`. For `commitMirrored`: add `{ _id: name, leaseToken: token }` as the fencing check.

**MirrorState document shape** (from RESEARCH.md Pattern 3):
```typescript
export type MirrorState = {
  _id: string;           // collection name
  dirtySeq: number;
  mirroredSeq: number;
  dueAt: Date;
  failures: number;
  nextAttemptAt: Date;
  lastError: string | null;    // error code only, never PII
  lastMirroredAt: Date | null;
  contentHash: string | null;
  lastWrittenEtag: string | null;
  externalChangeAt: Date | null;
  foldersCreated: boolean;
};
```

---

### `src/mirror/lease.ts` (utility, Mongo atomic)

**Analog:** `src/collections/idempotency.ts`

**isDuplicateKey pattern** (lines 71–73, `idempotency.ts`):
```typescript
const DUPLICATE_KEY = 11000;

export function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === DUPLICATE_KEY;
}
```
→ Import `isDuplicateKey` from `../collections/idempotency.ts` and use it to convert an E11000 from the lease upsert into `null` (someone else won the race).

**Upsert-with-increment pattern** (lines 100–112, `idempotency.ts`):
```typescript
await this.#entries().insertOne({
  _id,
  ...
  status: "pending",
  ...
});
```
→ For lease acquisition use `findOneAndUpdate` with `{ upsert: true, returnDocument: "after" }` and `$inc: { token: 1 }`. Filter: `{ _id: "mirror:<name>", $or: [{ expiresAt: { $lt: now } }, { owner: me }] }`.

**Core lease pattern** (from RESEARCH.md Pattern 2):
```typescript
const me = `${hostname}-${process.pid}`;
const TTL_MS = 60_000;

async function acquire(leases: Collection, name: string): Promise<{ token: number } | null> {
  const now = new Date();
  try {
    const r = await leases.findOneAndUpdate(
      { _id: `mirror:${name}`, $or: [{ expiresAt: { $lt: now } }, { owner: me }] },
      { $set: { owner: me, expiresAt: new Date(now.getTime() + TTL_MS) }, $inc: { token: 1 } },
      { upsert: true, returnDocument: "after" },
    );
    return r ? { token: r.token as number } : null;
  } catch (e) {
    if (isDuplicateKey(e)) return null;
    throw e;
  }
}
```

---

### `src/mirror/path.ts` (utility, transform)

**Analog:** `src/storage/drive-path.ts`

**Single-responsibility function pattern** (from RESEARCH.md Pattern 6):
```typescript
// D-06: single exported function owns the name→path rule
export function collectionToRelPath(collectionName: string): string {
  return collectionName + ".xlsx";
  // "events/2026/signups" → "events/2026/signups.xlsx"
  // "contacts"           → "contacts.xlsx"
}

export function collectionToFolderPath(collectionName: string): string | null {
  const slash = collectionName.lastIndexOf("/");
  return slash < 0 ? null : collectionName.slice(0, slash);
}
```
No imports needed (pure string transforms). The relative path is passed to `WritableMount.write(relPath, body)` which calls `mounts.resolve()` → `parseRelativePath()` → segment validation — so path safety is guaranteed by the existing storage layer.

---

### `src/mirror/workbook.ts` (utility, transform)

**Analog:** `src/collections/idempotency.ts` (`canonicalHash` function)

**Content hash pattern** (lines 44–63, `idempotency.ts`):
```typescript
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
```
→ For `computeContentHash`: hash the canonical data array (sorted record fields per column order), not the Buffer bytes — zip timestamps make raw bytes non-deterministic. Use `createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32)`.

**Imports pattern**:
```typescript
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
```

**Core workbook pattern** (from RESEARCH.md Pattern 4):
```typescript
/** XML control characters forbidden in OOXML cell values. */
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF]/g;
const FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r"]);

function sanitizeString(value: string, maxLen: number): string {
  let s = value.replace(ILLEGAL_XML, "");
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…[truncated]";
  return s;
}

/** Write a cell safely: never an object, never a formula. */
function setCellValue(cell: ExcelJS.Cell, value: unknown, maxLen: number): void {
  if (value === null || value === undefined) { cell.value = null; return; }
  if (typeof value === "boolean") { cell.value = value; return; }
  if (typeof value === "number") { cell.value = value; return; }
  if (value instanceof Date) { cell.value = value; return; }
  const s = sanitizeString(String(value), maxLen);
  cell.value = s; // string assignment = string cell type, never a formula
}

export function buildWorkbook(
  collectionName: string,
  schema: CollectionSchema,
  records: RecordDocument[],
  options: { maxCellLen?: number } = {},
): { buffer: Buffer; contentHash: string } { ... }
```

**Formula cell pattern** (D-11, from RESEARCH.md Pattern 4):
```typescript
// Set a TEXTJOIN formula over contiguous rows in an array sheet.
// Sheet names with spaces/dots/parens MUST be quoted in the formula string.
formulaCell.value = {
  formula: `_xlfn.TEXTJOIN(", ",TRUE,'tags'!$C$2:$C$4)`,
  result: "", // cached result for desktop viewers (at discretion)
};
```

**Key safety constraint:** Never pass a user data object (Record, Array) directly to `cell.value`. Flatten nested objects to dot-notation columns before the cell-writing stage. The `setCellValue` function only accepts primitives.

---

### `src/mirror/worker.ts` (service, event-driven + poll)

**Analogs:** `src/server.ts` (lifecycle + close pattern), `src/collections/store.ts` (Mongo patterns)

**Lifecycle pattern — start/stop** (lines 83–94, `server.ts`):
```typescript
return {
  app,
  close: async () => {
    indexSetup.stop();
    await app.close();
    await mongo.close();
  },
};
```
→ `MirrorWorker.start()` sets `#running = true` and fires the boot reconcile sweep + first tick. `MirrorWorker.stop()` sets `#running = false` and clears the timer.

**Non-blocking background job pattern** (lines 79–82, `server.ts`):
```typescript
// Not awaited: /health and /ready never depend on it, and an outage at boot only delays it.
const indexSetup = scheduleIndexSetup({
  ensure: () => ensureIndexes(db, config),
  log: { warn: (fields, message) => app.log.warn(fields, message) },
  retryMs: INDEX_RETRY_MS,
});
```
→ Worker loop follows the same fire-and-catch pattern. Never await the full loop inside the request path.

**Poll loop skeleton** (from RESEARCH.md):
```typescript
export class MirrorWorker {
  #running = false;
  #timer: NodeJS.Timeout | null = null;

  start(): void {
    this.#running = true;
    this.#scheduleReconcile(); // boot sweep: sets dueAt = now for every collection
    this.#tick();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) clearTimeout(this.#timer);
  }

  #tick(): void {
    if (!this.#running) return;
    this.#runOnce().catch(err => this.#log.warn({ err }, "mirror tick failed"));
    this.#timer = setTimeout(() => this.#tick(), POLL_INTERVAL_MS);
  }

  async #runOnce(): Promise<void> {
    const due = await this.#findDue(); // dueAt ≤ now AND dirtySeq > mirroredSeq
    for (const name of due) {
      const lease = await acquireLease(this.#leases, name);
      if (!lease) continue; // another instance holds it
      try {
        await this.#mirrorOne(name, lease.token);
      } finally {
        // Let the lease expire; heartbeat ran during #mirrorOne
      }
    }
  }
}
```

---

### `src/mirror/routes.ts` (controller, request-response)

**Analog:** `src/http/health.ts`

**Route registration pattern** (lines 16–34, `health.ts`):
```typescript
export function registerHealthRoutes(
  app: FastifyInstance,
  checks?: ReadinessChecks,
): void {
  app.get("/health", async () => ({ status: "ok" }));
  if (checks === undefined) return;

  app.get("/ready", async (request, reply) => {
    try {
      await checks.mongoPing();
    } catch (err) {
      request.log.warn({ err }, "mongo ping failed");
      return reply.status(503).send({ status: "not-ready", mongo: "down", drive: checks.driveState() });
    }
    return { status: "ready", mongo: "up", drive: checks.driveState() };
  });
}
```

**Auth guard pattern** (lines 72–97, `api-keys.ts`):
```typescript
export function requireGrant(keyStore: KeyStore, collection: string, operation: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const token = bearerToken(request.headers.authorization);
    const key = token === null ? null : await keyStore.resolve(token);
    if (key === null) {
      return reply.status(401).header("www-authenticate", "Bearer").type(PROBLEM_JSON).send(problem(401));
    }
    if (!key.grants.has(`${collection}:${operation}`)) {
      return reply.status(403).type(PROBLEM_JSON).send(problem(403));
    }
    principals.set(request, key.name);
    return undefined;
  };
}
```
→ For operator routes: `requireGrant(keyStore, "mirror", "status")` and `requireGrant(keyStore, "mirror", "rebuild")`.

**Operator routes shape** (D-22):
```typescript
export function registerMirrorRoutes(
  app: FastifyInstance,
  options: { keyStore: KeyStore; mirrorState: MirrorStateStore },
): void {
  app.get("/mirror/status",
    { onRequest: requireGrant(options.keyStore, "mirror", "status") },
    async () => { return options.mirrorState.getAll(); }
  );
  app.post("/mirror",
    { onRequest: requireGrant(options.keyStore, "mirror", "rebuild") },
    async (request, reply) => {
      const collection = (request.query as { collection?: string }).collection;
      await options.mirrorState.forceRebuild(collection);
      return reply.status(202).send();
    }
  );
}
```

---

### `src/collections/routes.ts` (CHANGE: dirty-mark after each write)

**Analog:** self — lines 219–240 (create), 300–317 (replace), 328–370 (patch), 371–385 (delete)

**Fire-and-forget dirty-mark pattern** (from RESEARCH.md):
```typescript
// In each mutation handler (create/replace/patch/delete), after the successful Mongo write:
void mirrorState.updateOne(
  { _id: collectionName },
  {
    $inc: { dirtySeq: 1 },
    $max: { dueAt: new Date(Date.now() + config.mirror.debounce.defaultMs) },
  },
  { upsert: true },
).catch((err) => request.log.warn({ err }, "mirror dirty-mark failed"));
// Fire-and-forget is safe: the reconcile sweep catches any misses.
```
Insert this after the successful Mongo call in each of: `store.insert(...)`, `store.replace(...)` (replace + patch), `store.remove(...)`.

---

### `src/config/schema.ts` (CHANGE: mirror block + nested collection names)

**Analog:** self — lines 80–129 (`mounts` and `collections` Record patterns)

**Record key pattern pattern** (lines 80–91, `schema.ts`):
```typescript
mounts: Type.Record(
  Type.String({ pattern: MOUNT_NAME_PATTERN }),
  Type.Object(
    { path: Type.String({ minLength: 1 }), mode: Type.Enum(["read", "read-write"]) },
    { additionalProperties: false },
  ),
  { additionalProperties: false, minProperties: 1 },
),
```
→ For collections: change key pattern from `MOUNT_NAME_PATTERN` to `COLLECTION_NAME_PATTERN = "^[a-z][a-z0-9-]{0,31}(\\/[a-z][a-z0-9-]{0,31})*$"` to allow slash-separated names.

**New mirror block** (TypeBox shape):
```typescript
mirror: Type.Optional(
  Type.Object(
    {
      mount: Type.String({ pattern: MOUNT_NAME_PATTERN }),
      debounce: Type.Optional(Type.Object(
        {
          defaultMs: Type.Optional(Type.Integer({ minimum: 1000 })),
          maxWaitMs: Type.Optional(Type.Integer({ minimum: 1000 })),
        },
        { additionalProperties: false },
      )),
      reconcileIntervalMs: Type.Optional(Type.Integer({ minimum: 1000 })),
    },
    { additionalProperties: false },
  ),
),
```
Add matching `mirror` field to the `Config` type with defaults: `defaultMs: 15_000`, `maxWaitMs: 180_000`, `reconcileIntervalMs: 900_000`.

---

### `src/config/load.ts` (CHANGE: mirror startup validation)

**Analog:** self — `mountIssues` function (lines 291–306) and `collectionIssues` (lines 408–456)

**Issue-collector pattern** (lines 60–73, `load.ts`):
```typescript
function collector() {
  const seen = new Set<string>();
  const issues: ConfigIssue[] = [];
  return {
    issues,
    add(issue: ConfigIssue): void {
      const key = JSON.stringify(issue);
      if (seen.has(key)) return;
      seen.add(key);
      issues.push(issue);
    },
  };
}
```
→ New `mirrorIssues(document, failed)` function follows the same shape. Issues to emit:

| Code | Condition |
|------|-----------|
| `mirror.REQUIRED` | Collections defined but `mirror` section absent |
| `mirror.MOUNT_UNKNOWN` | `mirror.mount` names a mount not in `mounts` |
| `mirror.MOUNT_NOT_WRITABLE` | Named mount has `mode: read` |

**Semantic issue registration** (lines 416–419, `load.ts`):
```typescript
semantic.push(...mountIssues(document, failed));
semantic.push(...collectionIssues(document, failed));
semantic.push(...apiKeyIssues(document, failed));
// ADD:
semantic.push(...mirrorIssues(document, failed));
```

---

### `src/collections/definition.ts` (CHANGE: slash names + operator grants)

**Analog:** self

**Name validation change** (lines 25–26, `definition.ts`):
```typescript
// BEFORE:
const NAME = new RegExp(MOUNT_NAME_PATTERN);

// AFTER:
// Import COLLECTION_NAME_PATTERN from schema.ts instead
const NAME = new RegExp(COLLECTION_NAME_PATTERN);
```

**Reserved-name check change** (lines 423–428, `definition.ts`):
```typescript
// BEFORE:
if (RESERVED_COLLECTION_NAMES.has(name)) {
  report({ code: "collection.RESERVED_NAME", at: base });
}

// AFTER: D-21 — first segment only
const firstSegment = name.split("/")[0];
if (firstSegment !== undefined && RESERVED_COLLECTION_NAMES.has(firstSegment)) {
  report({ code: "collection.RESERVED_NAME", at: base });
}
```

**Operator grants allowlist pattern** (lines 494–510, `definition.ts`):
```typescript
// BEFORE (single else-if):
} else if (!collections.has(collection) || !OPERATIONS.has(operation)) {
  issues.push({ code: "apiKey.UNKNOWN_GRANT", at });
}

// AFTER: add operator grants check before the existing check
const OPERATOR_GRANTS = new Map([
  ["mirror", new Set(["status", "rebuild"])],
]);
// In apiKeyIssues, before the else-if:
const operatorOps = OPERATOR_GRANTS.get(collection);
if (operatorOps && operatorOps.has(operation)) {
  // valid operator grant — no issue
} else if (!collections.has(collection) || !OPERATIONS.has(operation)) {
  issues.push({ code: "apiKey.UNKNOWN_GRANT", at });
}
```

---

### `src/app.ts` (CHANGE: mirror option + operator route registration)

**Analog:** self — lines 10–45

**Plugin registration pattern** (lines 38–45, `app.ts`):
```typescript
registerHealthRoutes(app, options.checks);
if (options.collections) registerCollections(app, options.collections);
// ADD:
if (options.mirror) registerMirrorRoutes(app, options.mirror);
```

**AppOptions extension**:
```typescript
/** Without it no mirror operator routes are registered. */
mirror?: { keyStore: KeyStore; mirrorState: MirrorStateStore };
```

---

### `src/server.ts` (CHANGE: ROLE env var + worker lifecycle)

**Analog:** self — lines 19–94

**ROLE-based branching pattern** (from RESEARCH.md Pattern 1):
```typescript
const role = (options.env ?? process.env).ROLE ?? "all";
// role: "api" | "worker" | "all"

// API routes: api | all only
const app = buildApp({
  ...baseOptions,
  collections: (role === "api" || role === "all") ? { config, db } : undefined,
  mirror: (role !== "api") ? { keyStore, mirrorState } : undefined,
});

// Worker loop: worker | all
let worker: MirrorWorker | undefined;
if (role === "worker" || role === "all") {
  worker = new MirrorWorker({ db, mounts, config, log: app.log });
  worker.start();
}
```

**Close pattern** (lines 86–91, `server.ts`):
```typescript
close: async () => {
  indexSetup.stop();
  worker?.stop();          // ADD: stop worker before closing app
  await app.close();
  await mongo.close();
},
```

---

### `src/http/health.ts` (CHANGE: informational mirror lag)

**Analog:** self — lines 23–34

**Non-blocking health field pattern** (lines 30–34, `health.ts`):
```typescript
return { status: "ready", mongo: "up", drive: checks.driveState() };
// ADD informational mirror field — never fails /ready (D-16, Drive outage must not fail /ready):
return {
  status: "ready", mongo: "up", drive: checks.driveState(),
  mirror: checks.mirrorLag?.() ?? "unknown",
};
```
`mirrorLag()` is synchronous (reads in-memory or cached `mirror_state`); it must never throw or block. Extend `ReadinessChecks` with `mirrorLag?: () => { lagSeconds: number; pendingCollections: number } | "unknown"`.

---

### `test/helpers/collections-app.ts` (CHANGE: extend for mirror tests)

**Analog:** self — lines 55–113

**Config generation pattern** (lines 63–89, `collections-app.ts`):
```typescript
const document = {
  mongo: { uri: mongoUri },
  storage: { webdav: { url: STACK.webdavUrl, username: STACK.webdavUser, password: STACK.webdavPassword } },
  mounts: { live: { path: `/run-${runId}`, mode: "read-write" } },
  collections: options.collections,
  apiKeys: (options.keys ?? []).map(k => ({ name: k.name, hash: sha256Hex(k.key), grants: k.grants })),
};
```
→ For `mirrorApp` helper, add `mirror: { mount: "live" }` and optional worker-timing overrides. Use short debounce (100 ms) and TTL (500 ms) in tests.

**Start options with timing** (lines 85–90, `collections-app.ts`):
```typescript
const service = await start({
  env: { CONFIG_FILE: file, PORT: "0" },
  logStream: logs.stream,
  adapterTimings: { retries: 1, minTimeout: 1, maxTimeout: 5 },
});
```
→ Extend `start()` to also accept `workerTimings?: { pollIntervalMs, debounceMs, ttlMs }` for fast test cycles.

---

### `test/integration/mirror-lease.test.ts` (new: two-instance test)

**Analog:** `test/integration/collections.test.ts` / `test/helpers/collections-app.ts`

**Two-instance setup pattern** (from RESEARCH.md Pattern 8):
```typescript
// Two instances, same DB, same WebDAV folder
const instanceA = await mirrorApp({ dbName, ...opts });
const instanceB = await mirrorApp({ dbName, ...opts });

// Trigger dirty-mark on one instance
await instanceA.fetch("/v1/contacts", { method: "POST", body: JSON.stringify({...}), ... });

// Wait for debounce + upload
await new Promise(r => setTimeout(r, debounceMs + 2000));

// Verify: mirror_state.mirroredSeq === dirtySeq; exactly one upload version in Drive
```

**Database isolation pattern** (lines 59–61, `collections-app.ts`):
```typescript
const runId = inject("runId");
const scratch = mkdtempSync(join(tmpdir(), "snook-mirror-"));
const dbName = `it-${runId}-mirror-${counter++}`;
```

---

## Shared Patterns

### Authentication Guard
**Source:** `src/auth/api-keys.ts` (lines 72–97)
**Apply to:** `src/mirror/routes.ts` — both `GET /mirror/status` and `POST /mirror`
```typescript
{ onRequest: requireGrant(keyStore, "mirror", "status") }  // GET /mirror/status
{ onRequest: requireGrant(keyStore, "mirror", "rebuild") } // POST /mirror
```

### Config Issue Collector
**Source:** `src/config/load.ts` (lines 60–73) — `collector()` function
**Apply to:** New `mirrorIssues()` function in `src/config/load.ts`
```typescript
const found = collector();
// found.add({ code: "mirror.REQUIRED", at: "/mirror" });
// found.add({ code: "mirror.MOUNT_UNKNOWN", at: "/mirror/mount" });
// found.add({ code: "mirror.MOUNT_NOT_WRITABLE", at: "/mirror/mount" });
return found.issues;
```

### Error-Code Logging (no PII)
**Source:** `src/config/load.ts` (lines 32–39) + `src/server.ts` (lines 60–77)
**Apply to:** All files in `src/mirror/` — especially `worker.ts` and `state.ts`
```typescript
// Log collection name and error code only; never record content, cell values, or truncation content
app.log.warn({ err: { type: err.constructor.name }, collection: name }, "mirror upload failed");
// NOT: app.log.warn({ err, cellValue: ... })
```

### Mongo `isDuplicateKey`
**Source:** `src/collections/idempotency.ts` (lines 71–73)
**Apply to:** `src/mirror/lease.ts` — catch E11000 on upsert race
```typescript
import { isDuplicateKey } from "../collections/idempotency.ts";
// In acquire():
} catch (e) {
  if (isDuplicateKey(e)) return null;
  throw e;
}
```

### StorageError Kind Handling
**Source:** `src/storage/errors.ts`
**Apply to:** `src/mirror/worker.ts` — MKCOL and upload error handling
```typescript
import { StorageError } from "../storage/errors.ts";
// catch "not-found" → MKCOL parent folders
// catch "conflict"  → flag in state (folder expected, file found)
// catch "rate-limited" → backoff via existing WebDavAdapter retry
```

### TypeBox Config Schema Extension
**Source:** `src/config/schema.ts` (lines 44–144)
**Apply to:** New `mirror` block in `ConfigSchema` and `Config` type
```typescript
// Follow existing pattern: Type.Optional(Type.Object({...}, { additionalProperties: false }))
// Match each schema field to a Config type field with explicit default in withDefaults()
```

### Integration Test Helper
**Source:** `test/helpers/collections-app.ts` (full file)
**Apply to:** New `test/helpers/mirror-app.ts` (or extend `collections-app.ts`)
```typescript
// Same shape: mkdtempSync scratch dir, generated config.yaml, start(), inject("runId"),
// per-test dbName, drop on close. Add: mirror config block, worker timing options,
// MirrorWorker reference on the returned object for stop() in teardown.
```

---

## No Analog Found

All new files have close analogs in the existing codebase. The `src/mirror/workbook.ts` module uses `exceljs` which is new to the project, but the content-hash and string-sanitisation patterns come from existing code.

| File | Note |
|------|------|
| `src/mirror/workbook.ts` (exceljs internals) | No existing xlsx generation in codebase; patterns come from RESEARCH.md Pattern 4 and PITFALLS.md research |

---

## Metadata

**Analog search scope:** `src/`, `test/helpers/`, `test/integration/`
**Files scanned:** 17 source files + 2 test helper files
**All analogs git-tracked:** verified with `git ls-files`
**Pattern extraction date:** 2026-11-22
