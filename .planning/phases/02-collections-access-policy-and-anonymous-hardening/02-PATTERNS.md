# Phase 02: Collections, Access Policy and Anonymous Hardening — Pattern Map

**Mapped:** 2026-11-22
**Files analyzed:** 13 new/modified files
**Analogs found:** 10 / 13 (3 have no analog — first of their kind in this codebase)

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/config/schema.ts` | config | — | `src/config/schema.ts` | modify-in-place |
| `src/config/load.ts` | config | — | `src/config/load.ts` | modify-in-place |
| `src/app.ts` | provider/composition-root | request-response | `src/app.ts` | modify-in-place |
| `src/collections/schema-registry.ts` | utility | transform | `src/storage/mounts.ts` (startup-validated registry) | role-match |
| `src/collections/record-repo.ts` | service | CRUD | `src/storage/mount-view.ts` (interface + impl, MongoDB ops) | role-match |
| `src/collections/idempotency-repo.ts` | service | CRUD | `src/db/mongo.ts` + `src/storage/mount-view.ts` | partial |
| `src/collections/collection-service.ts` | service | request-response | `src/storage/mount-view.ts` (service wrapping lower layer) | role-match |
| `src/collections/routes.ts` | route/controller | request-response | `src/http/health.ts` (Fastify route registrar) | role-match |
| `src/auth/key-store.ts` | service/middleware | request-response | `src/storage/adapter.ts` (interface) + `src/storage/mount-view.ts` (impl) | role-match |
| `src/auth/policy.ts` | middleware | request-response | `src/http/logging.ts` (Fastify hooks) | partial |
| `src/keygen.ts` | utility | — | `src/server.ts` (Node.js script entry point) | partial |
| `deploy/kong.yml` | config | — | `config/config.example.yaml` (YAML config artefact) | partial |
| `config/config.example.yaml` | config | — | `config/config.example.yaml` | modify-in-place |

---

## Pattern Assignments

### `src/config/schema.ts` (config — extend in place)

**Analog:** `src/config/schema.ts` (modify-in-place)

**Imports pattern** (lines 1):
```typescript
import Type from "typebox";
```
> Phase 2 adds no new import — `Type` from `typebox` is already the only import.

**Existing schema shape** (lines 14–56):
```typescript
export const MOUNT_NAME_PATTERN = "^[a-z][a-z0-9-]{0,31}$";

export const ConfigSchema = Type.Object(
  {
    server: Type.Optional(
      Type.Object(
        {
          port: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
          logLevel: Type.Optional(Type.Enum([...LOG_LEVELS])),
        },
        { additionalProperties: false },
      ),
    ),
    // ...existing mongo, storage, mounts...
  },
  { additionalProperties: false },
);
```

**Core extension pattern** — add to `server`, then append `collections` and `apiKeys` as top-level keys:
```typescript
// Inside server object — add trustProxy:
server: Type.Optional(
  Type.Object(
    {
      port:        Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
      logLevel:    Type.Optional(Type.Enum([...LOG_LEVELS])),
      trustProxy:  Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
      docs:        Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
),

// New top-level keys (follow the same additionalProperties: false pattern):
collections: Type.Optional(
  Type.Record(
    Type.String({ pattern: MOUNT_NAME_PATTERN }),
    CollectionDefSchema,          // see Code Examples in RESEARCH.md
    { additionalProperties: false },
  ),
),
apiKeys: Type.Optional(
  Type.Array(ApiKeySchema),       // see Code Examples in RESEARCH.md
),
```

**Key rule:** `additionalProperties: false` at every level. `Type.Enum` for allowed string values. `Type.Record` with the pattern option on the key (same as existing `mounts`). Unknown key → one `schema.additionalProperties` issue, not a silent acceptance.

**Config type extension** — add to `Config` type at bottom of file:
```typescript
readonly server: {
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly trustProxy: readonly string[];   // default []
  readonly docs: boolean;                   // default false
};
readonly collections: {
  readonly [name: string]: CollectionDef;
};
readonly apiKeys: readonly ApiKeyEntry[];
```

---

### `src/config/load.ts` (config — extend in place)

**Analog:** `src/config/load.ts` (modify-in-place)

**Imports pattern** (lines 1–14):
```typescript
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { type Document, isNode, parseDocument } from "yaml";
import { buildMounts, type MountDef, type MountMode } from "../storage/mounts.ts";
import { type Config, ConfigSchema, LOG_LEVELS, MOUNT_NAME_PATTERN } from "./schema.ts";
```
> Phase 2 adds no new npm imports here. Add `createHash` from `"node:crypto"` for key-hash format checking at startup.

**Collector / ConfigError pattern** (lines 18–40 — reuse as-is):
```typescript
export type ConfigIssue = { code: string; at?: string; line?: number; col?: number };

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[]) {
    super(`invalid configuration: ${issues.length} issue(s)`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

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

**Semantic-check function pattern** (lines 230–260 — `mountIssues` as template):
```typescript
// mountIssues() structure — copy this shape for collectionIssues() and apiKeyIssues():
function mountIssues(document: unknown, failed: Set<string>): ConfigIssue[] {
  if (!isRecord(document) || !isRecord(document.mounts)) return [];
  // ...iterate over entries, validate each, push issues...
  return issues;
}

// New functions follow identical structure:
function collectionIssues(document: unknown, failed: Set<string>): ConfigIssue[] { ... }
function apiKeyIssues(document: unknown, failed: Set<string>): ConfigIssue[] { ... }
```

**All-at-once error collection** (lines 290–310 — `loadConfig` tail):
```typescript
const issues = [
  ...envIssues.issues,
  ...inDocumentOrder(doc, schemaIssues(document, failed)),
  ...inDocumentOrder(doc, semantic),   // ← add collection + apiKey semantic issues here
];
if (issues.length > 0) throw new ConfigError(issues);
return deepFreeze(withDefaults(document as Record<string, unknown>));
```

**`withDefaults` extension:**
```typescript
function withDefaults(document: Record<string, unknown>): Config {
  const server = (document.server ?? {}) as Partial<Config["server"]>;
  return {
    // ...existing fields...
    server: {
      port:       server.port       ?? 3000,
      logLevel:   server.logLevel   ?? "info",
      trustProxy: server.trustProxy ?? [],   // new
      docs:       server.docs       ?? false,  // new
    },
    collections: (document.collections ?? {}) as Config["collections"],
    apiKeys:     (document.apiKeys     ?? [])  as Config["apiKeys"],
  };
}
```

---

### `src/app.ts` (composition root — extend in place)

**Analog:** `src/app.ts` (modify-in-place)

**Current shape** (lines 1–22, full file):
```typescript
import Fastify, { type FastifyInstance, LogController } from "fastify";
import type { DestinationStream } from "pino";
import { type ReadinessChecks, registerHealthRoutes } from "./http/health.ts";
import { loggerOptions, registerLogging } from "./http/logging.ts";

export interface AppOptions {
  logger?: { level?: string; stream?: DestinationStream };
  checks?: ReadinessChecks;
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions(options.logger?.level, options.logger?.stream),
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
  });
  registerLogging(app);
  registerHealthRoutes(app, options.checks);
  return app;
}
```

**Extension pattern** — `AppOptions` grows a `config` field; `buildApp` registers new plugins in order:
```typescript
export interface AppOptions {
  logger?: { level?: string; stream?: DestinationStream };
  checks?: ReadinessChecks;
  config?: Config;          // new — undefined when used in unit tests with no collections
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions(options.logger?.level, options.logger?.stream),
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
  });
  registerLogging(app);
  registerHealthRoutes(app, options.checks);

  // Phase 2 additions — only when config is present:
  if (options.config) {
    const cfg = options.config;
    // Global plugins (fastify-plugin wrapped, visible in all child scopes):
    app.register(fp(helmet, { ... }));
    app.register(fp(swagger, { openapi: { openapi: "3.1.0", ... } }));
    app.register(fp(swaggerUi, { routePrefix: "/docs" }));
    app.register(fp(keyStorePlugin, { keys: cfg.apiKeys }));
    app.register(fp(mongoPlugin));           // decorates app.mongo
    app.register(fp(authPlugin));            // onRequest principal hook

    // Per-collection encapsulated plugins (NOT fp-wrapped):
    for (const [name, def] of Object.entries(cfg.collections)) {
      app.register(collectionPlugin(name, def, cfg.server.trustProxy), {
        prefix: `/v1/${name}`,
      });
    }
  }

  return app;
}
```

**Key rules from existing code:**
- `requestIdHeader: false` — keep (never trust client-sent request IDs)
- `disableRequestLogging: true` — keep (logging.ts emits the safe single line)
- `registerLogging` always first — error handler must be in place before collection plugins

---

### `src/collections/schema-registry.ts` (utility — startup Ajv compilation)

**Analog:** `src/storage/mounts.ts` (startup-validated registry pattern)

**Registry / fail-fast builder pattern** (lines 125–145 of `mounts.ts`):
```typescript
// buildMounts() pattern: validate everything at startup, return ok/issues result
export function buildMounts(
  defs: Record<string, MountDef>,
): { ok: true; mounts: Mounts } | { ok: false; issues: MountIssue[] } {
  const issues: MountIssue[] = [];
  const entries = new Map<string, MountEntry>();
  for (const [name, def] of Object.entries(defs)) {
    // validate, push issues or build entry
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, mounts: new Mounts(entries) };
}
```

**Apply to SchemaRegistry:**
```typescript
// src/collections/schema-registry.ts
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import type { ConfigIssue } from "../config/load.ts";
import type { CollectionDef } from "../config/schema.ts";

export class SchemaRegistry {
  readonly #validators: Map<string, ValidateFunction>;

  constructor(validators: Map<string, ValidateFunction>) {
    this.#validators = validators;
  }

  validate(collection: string, body: unknown): string[] | null {
    const fn = this.#validators.get(collection);
    if (!fn) throw new Error(`unknown collection: ${collection}`);
    if (fn(body)) return null;
    // Never return fn.errors (contains submitted values) — return error keywords only
    return (fn.errors ?? []).map((e) => `${e.instancePath} ${e.keyword}`);
  }
}

// Called once at startup — same fail-fast pattern as buildMounts():
export function buildSchemaRegistry(
  collections: Record<string, CollectionDef>,
): { ok: true; registry: SchemaRegistry } | { ok: false; issues: ConfigIssue[] } {
  const strictAjv = new Ajv({ strict: true, coerceTypes: false,
    removeAdditional: false, useDefaults: false, allErrors: false });
  addFormats(strictAjv);
  const issues: ConfigIssue[] = [];
  const validators = new Map<string, ValidateFunction>();
  for (const [name, def] of Object.entries(collections)) {
    try {
      validators.set(name, strictAjv.compile(def.schema));
    } catch (err) {
      issues.push({ code: "collection.INVALID_SCHEMA", at: `/collections/${name}` });
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, registry: new SchemaRegistry(validators) };
}
```

---

### `src/collections/record-repo.ts` (service — MongoDB CRUD)

**Analog:** `src/storage/mount-view.ts` (service class wrapping a backend, async methods)

**Interface + class pattern** (lines 1–45 of `mount-view.ts`):
```typescript
// StorageAdapter interface (adapter.ts) → MountView implementation (mount-view.ts)
// Same pattern: define interface, implement class with #private fields
export interface StorageAdapter {
  stat(p: ResolvedPath): Promise<StatEntry>;
  list(p: ResolvedPath): Promise<StatEntry[]>;
  read(p: ResolvedPath, opts?: ReadOptions): Promise<Buffer>;
  write(p: ResolvedPath, body: Buffer): Promise<StatEntry>;
  delete(p: ResolvedPath): Promise<void>;
}

export class MountView {
  readonly name: string;
  readonly mode: "read" | "read-write";
  readonly #mounts: Mounts;
  readonly #adapter: StorageAdapter;

  constructor(mounts: Mounts, adapter: StorageAdapter, name: string) { ... }

  async list(rel: string): Promise<StatEntry[]> {
    return this.#adapter.list(this.#mounts.resolve(this.name, rel));
  }
  async delete(rel: string): Promise<void> {
    this.#assertWritable("delete");
    return this.#adapter.delete(this.#mounts.resolve(this.name, rel));
  }
}
```

**Apply to RecordRepository:**
```typescript
// src/collections/record-repo.ts
import type { Collection, Db, Filter, Document } from "mongodb";

export interface RecordDocument {
  _id: string;        // crypto.randomUUID()
  createdAt: string;  // ISO 8601
  updatedAt: string;  // ISO 8601
  _version: number;   // 1 on create, +1 on each write
}

export class RecordRepository {
  readonly #col: Collection<RecordDocument>;

  constructor(db: Db, collectionName: string) {
    this.#col = db.collection<RecordDocument>(`col_${collectionName}`);
  }

  async ensureIndexes(indexedFields: readonly string[]): Promise<void> {
    // One compound index per indexed field — same pattern as mounts' startup validation
    for (const field of indexedFields) {
      await this.#col.createIndex({ [field]: 1, _id: 1 },
        { name: `idx_${field.replace(/\./g, "_")}_id` });
    }
    await this.#col.createIndex({ createdAt: -1, _id: -1 },
      { name: "idx_createdAt_id" });
  }

  async insert(doc: RecordDocument): Promise<RecordDocument> {
    await this.#col.insertOne(doc as Document);
    return doc;
  }

  async findById(id: string): Promise<RecordDocument | null> {
    return this.#col.findOne({ _id: id } as Filter<RecordDocument>);
  }

  // list(), replace(), patch(), deleteOne() follow same async method shape
}
```

---

### `src/collections/idempotency-repo.ts` (service — MongoDB TTL)

**Analog:** `src/db/mongo.ts` (MongoDB client wrapper) + `src/storage/mount-view.ts` (service class)

**Mongo wrapper pattern** (full `mongo.ts`):
```typescript
// createMongo() — simple function returning an interface
export interface Mongo {
  client: MongoClient;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function createMongo(uri: string): Mongo {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1500 });
  return {
    client,
    ping: async () => { await client.db("admin").command({ ping: 1 }); },
    close: () => client.close(),
  };
}
```

**Apply to IdempotencyRepository:**
```typescript
// src/collections/idempotency-repo.ts
import { createHash } from "node:crypto";
import type { Collection, Db } from "mongodb";

export type IdempotencyStatus = "pending" | "complete";

export interface IdempotencyEntry {
  _id: string;             // sha256(`${collection}:${rawKey}`)
  bodyHash: string;        // sha256(JSON.stringify(sortedBody))
  status: IdempotencyStatus;
  response?: unknown;      // stored on complete
  createdAt: Date;         // TTL index on this field
}

export class IdempotencyRepository {
  readonly #col: Collection<IdempotencyEntry>;

  constructor(db: Db) {
    this.#col = db.collection<IdempotencyEntry>("idempotency_keys");
  }

  async ensureIndexes(): Promise<void> {
    // TTL index — same ensureIndexes() pattern as RecordRepository
    await this.#col.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 86400, name: "ttl_24h" },
    );
    // unique on _id enforced by MongoDB default
  }

  static keyId(collection: string, rawKey: string): string {
    return createHash("sha256").update(`${collection}:${rawKey}`).digest("hex");
  }

  static bodyHash(body: unknown): string {
    return createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex");
  }

  async find(id: string): Promise<IdempotencyEntry | null> {
    return this.#col.findOne({ _id: id });
  }

  async insertPending(id: string, bodyHash: string): Promise<void> {
    await this.#col.insertOne({
      _id: id, bodyHash, status: "pending", createdAt: new Date(),
    });
  }

  async complete(id: string, response: unknown): Promise<void> {
    await this.#col.updateOne({ _id: id },
      { $set: { status: "complete", response } });
  }
}
```

---

### `src/collections/collection-service.ts` (service — business logic)

**Analog:** `src/storage/mount-view.ts` (service wrapping a repository, translates domain errors)

**Service delegation pattern** (lines 55–105 of `mount-view.ts`):
```typescript
// MountView delegates to adapter; throws StorageError with kind + op only
async list(rel: string): Promise<StatEntry[]> {
  return this.#adapter.list(this.#mounts.resolve(this.name, rel));
}

async write(rel: string, body: Buffer): Promise<StatEntry> {
  this.#assertWritable("write");   // mode guard before delegation
  return this.#adapter.write(this.#mounts.resolve(this.name, rel), body);
}
```

**StorageError pattern** (lines 1–20 of `errors.ts`):
```typescript
// Domain error with kind + op; never includes path or value
export class StorageError extends Error {
  readonly kind: StorageErrorKind;
  readonly op: string;
  constructor(kind: StorageErrorKind, op: string) {
    super(`${op}: ${kind}`);
    this.name = "StorageError";
    this.kind = kind;
    this.op = op;
  }
}
```

**Apply to CollectionService:**
```typescript
// src/collections/collection-service.ts
import { randomUUID } from "node:crypto";
import type { SchemaRegistry } from "./schema-registry.ts";
import type { RecordRepository, RecordDocument } from "./record-repo.ts";
import type { IdempotencyRepository } from "./idempotency-repo.ts";

// Domain error — same shape as StorageError (kind + op, no values)
export class CollectionError extends Error {
  readonly kind: "not-found" | "conflict" | "validation" | "precondition-failed"
                | "idempotency-conflict" | "idempotency-mismatch";
  readonly op: string;
  constructor(kind: CollectionError["kind"], op: string) {
    super(`${op}: ${kind}`);
    this.name = "CollectionError";
    this.kind = kind;
    this.op = op;
  }
}

export class CollectionService {
  #registry: SchemaRegistry;
  #repo: RecordRepository;
  #idempRepo: IdempotencyRepository;

  constructor(registry: SchemaRegistry, repo: RecordRepository, idempRepo: IdempotencyRepository) {
    this.#registry = registry;
    this.#repo = repo;
    this.#idempRepo = idempRepo;
  }

  async create(collection: string, body: unknown): Promise<RecordDocument> {
    const errors = this.#registry.validate(collection, body);
    if (errors) throw new CollectionError("validation", "create");
    const now = new Date().toISOString();
    const doc: RecordDocument = {
      _id: randomUUID(),
      ...(body as object),
      createdAt: now,
      updatedAt: now,
      _version: 1,
    };
    return this.#repo.insert(doc);
  }
  // get(), list(), replace(), patch(), delete() follow same delegation shape
}
```

---

### `src/collections/routes.ts` (route/controller — Fastify plugin registrar)

**Analog:** `src/http/health.ts` (Fastify route registration function)

**Route registrar pattern** (full `health.ts`):
```typescript
// registerHealthRoutes: takes app + options, registers routes, no return value
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
      return reply.status(503).send({ ... });
    }
    return { status: "ready", ... };
  });
}
```

**Apply to collection route plugin:**
```typescript
// src/collections/routes.ts
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import type { CollectionDef } from "../config/schema.ts";
import type { CollectionService } from "./collection-service.ts";

// Returns an async plugin function — registered per collection in app.ts
export function collectionPlugin(
  name: string,
  def: CollectionDef,
  service: CollectionService,
  trustProxy: readonly string[],
) {
  return async (scope: FastifyInstance): Promise<void> => {
    // Encapsulated scope: CORS, rate-limit, body-limit, Ajv all scoped here
    scope.setValidatorCompiler(({ schema }) => strictAjv.compile(schema));
    await scope.register(cors, { origin: def.cors?.origins ?? [] });
    await scope.register(rateLimit, {
      max: def.rateLimit?.max ?? 10,
      timeWindow: (def.rateLimit?.windowSeconds ?? 60) * 1000,
    });

    // POST /v1/{name}
    scope.post("/", {
      bodyLimit: def.bodyLimit ?? 65536,
      schema: { ... },  // TypeBox-derived body + response schemas
      preHandler: [authorizeHook(name, "create"), honeypotHook(def.honeypot), idempotencyHook(name)],
    }, async (request, reply) => {
      // handler delegates to CollectionService — same pattern as health.ts handler
      const record = await service.create(name, request.body);
      return reply.status(201).send(toAnonymousResponse(record));
    });

    // GET /v1/{name}
    scope.get("/", { preHandler: [authorizeHook(name, "list")] }, async (request, reply) => { ... });

    // GET /v1/{name}/:id  PUT  PATCH  DELETE follow same pattern
  };
}
```

---

### `src/auth/key-store.ts` (service — interface + implementation)

**Analog:** `src/storage/adapter.ts` (interface) + `src/storage/mount-view.ts` (implementation with #private fields)

**Interface definition pattern** (`adapter.ts` lines 1–30):
```typescript
// Pure interface — no implementation details
export interface StorageAdapter {
  stat(p: ResolvedPath): Promise<StatEntry>;
  list(p: ResolvedPath): Promise<StatEntry[]>;
  read(p: ResolvedPath, opts?: ReadOptions): Promise<Buffer>;
  write(p: ResolvedPath, body: Buffer): Promise<StatEntry>;
  delete(p: ResolvedPath): Promise<void>;
}
```

**#private field class pattern** (`mount-view.ts` lines 32–44):
```typescript
export class MountView {
  readonly name: string;
  readonly mode: "read" | "read-write";
  readonly #mounts: Mounts;         // private — not accessible outside class
  readonly #adapter: StorageAdapter;

  constructor(mounts: Mounts, adapter: StorageAdapter, name: string) {
    this.#mounts = mounts;
    this.#adapter = adapter;
    this.name = name;
    this.mode = mounts.get(name).mode;
  }
```

**Apply to KeyStore:**
```typescript
// src/auth/key-store.ts
import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiKeyEntry } from "../config/schema.ts";

export type ResolvedKey = { id: string; grants: ReadonlySet<string> };

// Interface — same style as StorageAdapter
export interface KeyStore {
  resolve(rawKey: string): Promise<ResolvedKey | null>;
}

// Implementation — same #private field pattern as MountView
export class ConfigKeyStore implements KeyStore {
  readonly #entries: Map<string, { hash: Buffer; grants: ReadonlySet<string> }>;

  constructor(keys: readonly ApiKeyEntry[]) {
    // Build at construction time — no lazy compilation
    this.#entries = new Map(
      keys.map((k) => [
        k.name,
        { hash: Buffer.from(k.hash, "hex"), grants: new Set(k.grants) },
      ]),
    );
  }

  async resolve(rawKey: string): Promise<ResolvedKey | null> {
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

### `src/auth/policy.ts` (middleware — Fastify hook function)

**Analog:** `src/http/logging.ts` (Fastify hook + handler registration pattern)

**Hook registration pattern** (`logging.ts` lines 65–100):
```typescript
export function registerLogging(app: FastifyInstance): void {
  app.addHook("onResponse", async (request, reply) => {
    request.log.info({ req: request, res: reply, ms: ... }, "request");
  });

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.status(404).type(PROBLEM_JSON).send(problem(404));
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    const status = typeof error.statusCode === "number" && ...
      ? error.statusCode : 500;
    return reply.status(status).type(PROBLEM_JSON).send(problem(status));
  });
}

// problem() helper — reuse in policy.ts for 401/403 responses:
function problem(status: number) {
  return { type: "about:blank", title: STATUS_CODES[status] ?? "Error", status };
}
```

**Apply to policy.ts:**
```typescript
// src/auth/policy.ts
import { STATUS_CODES } from "node:http";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { CollectionDef } from "../config/schema.ts";

const PROBLEM_JSON = "application/problem+json";

function problem(status: number) {
  // Exact same helper as in logging.ts — copy, do not import cross-module
  return { type: "about:blank", title: STATUS_CODES[status] ?? "Error", status };
}

export type Operation = "create" | "get" | "list" | "replace" | "patch" | "delete";

// Returns a preHandler function — same async function shape as the hooks in logging.ts
export function authorizeHook(collection: string, def: CollectionDef, op: Operation) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const policy = def.operations[op];
    if (!policy) {
      await reply.status(403).type(PROBLEM_JSON).send(problem(403));
      return;
    }
    if (policy === "anonymous") return;
    if (policy === "apiKey") {
      const principal = (request as { principal?: { kind: string; grants?: ReadonlySet<string> } }).principal;
      if (principal?.kind !== "apiKey") {
        await reply.status(401).type(PROBLEM_JSON).send(problem(401));
        return;
      }
      if (!principal.grants?.has(`${collection}:${op}`)) {
        await reply.status(403).type(PROBLEM_JSON).send(problem(403));
        return;
      }
    }
  };
}
```

---

### `src/keygen.ts` (utility CLI — script entry point)

**Analog:** `src/server.ts` (Node.js script with `import.meta.main` guard)

**Script entry pattern** (`server.ts` lines 65–80):
```typescript
// import.meta.main guard — standard Bun/Node ESM entry pattern
if (import.meta.main) {
  try {
    const { close } = await start();
    const shutdown = (): void => {
      close().then(() => process.exit(0), () => process.exit(1));
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch (error) {
    const bootstrap = pino(pino.destination(2));
    if (error instanceof ConfigError) {
      bootstrap.fatal({ issues: error.issues }, "invalid configuration");
    } else {
      bootstrap.fatal({ err: { type: (error as Error).constructor.name } }, "startup failed");
    }
    process.exitCode = 1;
  }
}
```

**Apply to keygen.ts:**
```typescript
// src/keygen.ts — console-only script, no pino needed
import { randomBytes, createHash } from "node:crypto";

if (import.meta.main) {
  const id     = randomBytes(8).toString("hex");           // 16 hex chars
  const secret = randomBytes(24).toString("base64url");     // 32 URL-safe chars
  const rawKey = `mdra_${id}.${secret}`;
  const hash   = createHash("sha256").update(secret).digest("hex");

  console.log(`Key:  ${rawKey}`);
  console.log(`Hash: ${hash}`);
  console.log();
  console.log("Add to config.yaml:");
  console.log(`apiKeys:\n  - name: my-key\n    hash: "${hash}"\n    grants: []`);
}
```

---

### `deploy/kong.yml` (config artefact — no analog)

No analog exists. This is the first deploy artefact in the codebase. Use RESEARCH.md Pattern 12 directly.

**Structure from RESEARCH.md Pattern 12:**
```yaml
# deploy/kong.yml - Kong Gateway declarative config reference (deck v3)
# [ASSUMED] Kong config format — verify against target Kong version docs before use
_format_version: "3.0"

services:
  - name: mailbox-org-drive-rest-api
    url: http://api:3000
    routes:
      - name: all
        paths: [/]
        strip_path: false

plugins:
  - name: rate-limiting
    config:
      minute: 60
      policy: local
  - name: http-log
    config:
      http_endpoint: http://log-collector/ingest
      custom_fields_by_lua:
        method: "return kong.request.get_method()"
        path:   "return kong.request.get_path()"
        status: "return kong.response.get_status()"
```

---

### `config/config.example.yaml` (config artefact — extend in place)

**Analog:** `config/config.example.yaml` (modify-in-place)

**Existing comment and structure style** (lines 1–30 of `config.example.yaml`):
```yaml
# Example configuration. Copy to config/config.yaml (git-ignored) and adjust.
# Point the service at it with CONFIG_FILE (default: config/config.yaml).
#
# Any ${NAME} placeholder resolves from the environment variable NAME, or from
# the file named by NAME_FILE (for Docker/Kubernetes secrets).

storage: ...
mongo: ...
# Optional:
# server:
#   port: 3000
#   logLevel: info
mounts:
  forms:
    path: /Userstore/Example Service/forms
    mode: read-write
```

**Extension style** — append after `mounts`, keeping comment style:
```yaml
# Optional. Remove if not using API key access.
# apiKeys:
#   - name: backend
#     hash: "<sha256 hex of the secret — run: node src/keygen.ts>"
#     grants:
#       - contacts:create
#       - contacts:list

# Optional. Required for /docs UI. Off by default.
# server:
#   docs: true
#   trustProxy: []   # List of trusted proxy IPs/CIDRs, e.g. ["10.0.0.1/8"]

# Example collection:
# collections:
#   contacts:
#     schema:
#       type: object
#       properties:
#         email:    { type: string, format: email, maxLength: 254 }
#         message:  { type: string, maxLength: 2000 }
#       required: [email, message]
#       additionalProperties: false
#     operations:
#       create: anonymous
#       get:    apiKey
#       list:   apiKey
#       delete: apiKey
#     honeypot: website
#     cors:
#       origins: ["https://example.com"]
#     rateLimit:
#       max: 10
#       windowSeconds: 60
```

---

## Shared Patterns

### Error response: `problem()` + `PROBLEM_JSON` constant
**Source:** `src/http/logging.ts` (lines 56–62)
**Apply to:** `src/auth/policy.ts`, `src/collections/routes.ts` (401, 403, 404, 409, 412, 413, 415, 422, 429)
```typescript
// Copy this pair into each module that sends problem+json (do NOT cross-import logging.ts)
const PROBLEM_JSON = "application/problem+json";
function problem(status: number) {
  return { type: "about:blank", title: STATUS_CODES[status] ?? "Error", status };
}
```
> `logging.ts` already owns the global error handler and 404 handler. Route-level 4xx responses call `reply.status(N).type(PROBLEM_JSON).send(problem(N))` directly — the same shape, local copy.

### ConfigError / ConfigIssue + all-at-once collector
**Source:** `src/config/load.ts` (lines 18–40)
**Apply to:** `src/config/load.ts` extensions (collectionIssues, apiKeyIssues), `src/collections/schema-registry.ts`
```typescript
// All semantic checks accumulate into collector(); one throw at the end
const issues = [
  ...envIssues.issues,
  ...inDocumentOrder(doc, schemaIssues(document, failed)),
  ...inDocumentOrder(doc, semantic),
];
if (issues.length > 0) throw new ConfigError(issues);
```

### No value ever echoed in errors or logs
**Source:** `src/http/logging.ts` (lines 32–49, `serializeError`) + `src/config/load.ts` (all issues carry `code` + `at` only)
**Apply to:** Every new error path (401 auth, 403 policy, 400 validation, 409/412/422/429 idempotency/concurrency)
```typescript
// serializeError allows only: type, code, kind, op, status.
// No message, no stack, no field values, no path segments.
function serializeError(error: unknown) {
  const e = (error ?? {}) as Record<string, unknown>;
  return {
    type: ...,
    ...(e.code   !== undefined ? { code: e.code }   : {}),
    ...(e.kind   !== undefined ? { kind: e.kind }   : {}),
    ...(e.op     !== undefined ? { op:   e.op   }   : {}),
    ...(typeof e.statusCode === "number" ? { status: e.statusCode } : {}),
  };
}
```

### #private class fields
**Source:** `src/storage/mount-view.ts` (lines 32–44)
**Apply to:** `ConfigKeyStore`, `RecordRepository`, `IdempotencyRepository`, `CollectionService`, `SchemaRegistry`
```typescript
// Use # prefix for all internal state — prevents accidental external access
class MountView {
  readonly #mounts: Mounts;
  readonly #adapter: StorageAdapter;
  constructor(mounts: Mounts, adapter: StorageAdapter, ...) {
    this.#mounts = mounts; this.#adapter = adapter;
  }
}
```

### Fastify `inject()` unit tests
**Source:** `test/unit/health.test.ts` + `test/unit/logging-canary.test.ts`
**Apply to:** `test/unit/collections.test.ts`, `test/unit/auth.test.ts`
```typescript
// Unit test pattern: buildApp() → inject() → assert, always close in finally
const app = buildApp({ logger: { level: "silent" }, config: testConfig });
try {
  const res = await app.inject({ method: "POST", url: "/v1/contacts",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ ... }) });
  expect(res.statusCode).toBe(201);
} finally {
  await app.close();
}
```

### Canary / no-PII-in-logs assertion
**Source:** `test/unit/logging-canary.test.ts` (lines 30–45) + `test/helpers/log-capture.ts`
**Apply to:** New canary tests for 401/403/409/412/422/429 paths
```typescript
const CANARY = "CANARY-7f3a@example.invalid";
const logs = captureLogs();
const app = buildApp({ logger: { level: "info", stream: logs.stream }, config: ... });
// After each error-path request:
expect(res.body).not.toMatch(/canary-7f3a/i);
expect(logs.lines().join("\n")).not.toMatch(/canary-7f3a/i);
```

---

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `deploy/kong.yml` | config artefact | — | First deploy artefact in the codebase; no existing YAML deploy config to copy from. Use RESEARCH.md Pattern 12 directly. |
| `src/collections/routes.ts` preHandlers | middleware | request-response | Honeypot and idempotency preHandlers are new patterns. No existing middleware hooks in Phase 1. Use RESEARCH.md Patterns 5 and 6. |
| `src/auth/policy.ts` authPlugin (`onRequest` hook) | middleware | request-response | No existing auth hooks. Use RESEARCH.md Pattern 4 (`app.decorateRequest` + `app.addHook("onRequest", ...)` via `fastify-plugin`). |

---

## Metadata

**Analog search scope:** `src/` (all 15 files), `test/unit/`, `test/integration/`, `test/helpers/`, `config/`
**Files scanned:** 15 source files + 10 test files
**Git-tracked verification:** All 17 cited analog paths verified via `git ls-files`
**Pattern extraction date:** 2026-11-22
