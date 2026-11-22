# Phase 03: Mirror Worker — Research

**Researched:** 2026-11-22
**Domain:** Background worker, exceljs workbook generation, Mongo lease + fencing, nested WebDAV paths
**Confidence:** HIGH (locked decisions from CONTEXT.md + verified codebase; exceljs patterns from prior STACK.md research)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Drive write strategy (MIRR-03, MIRR-06)**
- D-01: Write the mirror with a **direct PUT** over the final file. No temp upload + MOVE. Torn reads accepted. No orphan cleanup needed.
- D-02: REQUIREMENTS.md MIRR-03 and ROADMAP Phase 3 SC3 must be reworded to "mirror written by a direct PUT per the spike; no temp files". **Planner applies this in the first plan.**
- D-03: Foreign change (Drive ETag ≠ last-written ETag) → overwrite with MongoDB truth and record in mirror status and logs (no content, no PII). Same on first write when file already exists.
- D-04: Skip upload when content is unchanged: canonical data hash stored in `mirror_state`. If file missing or Drive ETag differs from last write, upload even when hash matches.

**Where mirrors live (MIRR-01)**
- D-05: Mirror is **required, no opt-out**. Top-level `mirror: { mount: <name> }` required when any collection is defined. Mount must be `read-write` or startup fails.
- D-06: Path derived only from collection name: `<mirror_mount>/<collection>.xlsx` (nested: `<mount>/a/b/c.xlsx`). One function owns this rule.

**Columns and cell format (MIRR-04, MIRR-05)**
- D-07: Columns: `id` first, schema `properties` in declaration order, then `createdAt` and `updatedAt` last. Headers = raw JSON keys.
- D-08: **No config column mapping.** MIRR-04 must be reworded to "mirror columns follow the schema in a stable order". **Planner applies this together with D-02.**
- D-09: Nested objects → dot-notation columns (`address.country`).
- D-10: Arrays → separate sheet per array field. Scalar array: `id`, `index`, `value`. Object array: `id`, `index`, plus one column per object field (flattened with dots). `id` is a back-reference. Rows ordered in main-sheet row order within each record.
- D-11: Main sheet holds a **generated formula** for each array field: `_xlfn.TEXTJOIN(", ",TRUE,'<sheet>'!$C$<first>:$C$<last>)`. Empty array → empty string cell. Verified in OX on 2026-11-22. No further human checkpoint needed. At Claude's discretion: also write a cached `result` for desktop viewers.
- D-12: Rows sorted oldest-first by `createdAt`, then `_id`. Stable across regenerations.
- D-13: `format: date-time` / `date` fields and `createdAt`/`updatedAt` → real Excel date cells in UTC.
- D-14: Value over Excel's 32,767-char limit (or configurable cap) → truncated with `…[truncated]`. Log truncation count, never content.

**Timing, reconciliation and roles (MIRR-01, MIRR-07, FND-05)**
- D-15: Debounce in `config.yaml` (not env): default **15 s** after last write, **max wait 3 min** under constant traffic.
- D-16: Reconciliation = same worker job. On boot and every **15 min** (configurable), treat every collection as due. Content-hash skip avoids Drive writes when nothing changed.
- D-17: `ROLE` env var (`api` | `worker` | `all`), default `all`. A `worker` still serves `/health` and `/ready`.

**Operator API (MIRR-08)**
- D-22: Operator routes **unversioned at root**: `GET /mirror/status`, `POST /mirror`. Grants: `mirror:status`, `mirror:rebuild`. `mirror` is a reserved collection name, so it cannot clash.

**Nested collections (D-18..D-21)**
- D-18: Collection names may be **slash-separated** (`events/2026/signups`). Each segment matches `MOUNT_NAME_PATTERN`. Route `/v1/events/2026/signups`, mirror `<mount>/events/2026/signups.xlsx` with MKCOL for folders.
- D-19: No depth limit.
- D-20: A collection and a deeper one may share a prefix (`events` and `events/2026`).
- D-21: Reserved-name check applies to the **first segment only**.

### Claude's Discretion

- Rebuild semantics: `POST /mirror` returns 202, bypasses content-hash skip (forces upload), rebuilds all or one with `?collection=`.
- Status payload per collection: last mirrored time, lag (seconds and pending write count), last error as a code without PII, external-change notes from D-03.
- Formula-guard style for values starting with `=`, `+`, `-`, `@`, tab or CR: explicit string cell type at minimum. Adding a leading `'` is optional.
- Drive outage behaviour: backoff via existing adapter retry. `/ready` must not fail on Drive outage; mirror health is informational.
- Lease TTL, heartbeat and fencing details.
- `mirror_state` document shape.
- Two-instance test design (MIRR-02).
- MongoDB collection name encoding for slashes (use slash directly — verified OK below).
- Dotted/bracketed property key ambiguity (column name uniqueness — reject at startup).
- Main sheet summary for array of objects (COUNTIF over id column or TEXTJOIN over first scalar).
- `~2` suffix collision rule for sheet names over 31 chars.

### Deferred Ideas (OUT OF SCOPE)

None. Nested collections were pulled into this phase by the user (D-18..D-21).
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| MIRR-01 | Staff see each collection mirrored to its own `.xlsx` in Drive, regenerated (debounced) after record changes | Worker poll loop + `mirror_state` dirty counter; `WritableMount.write` for PUT |
| MIRR-02 | Only one writer updates a mirror at a time (Mongo lease with fencing), verified by two-instance test | Pattern 2 from ARCHITECTURE.md; `findOneAndUpdate` upsert with `$inc token`; two-instance integration test |
| MIRR-03 | Mirror writes are atomic as far as the spike shows (direct PUT per spike) | D-01; direct `adapter.write`; no temp files |
| MIRR-04 | Mirror columns follow the schema in a stable order | D-07/D-08; schema `properties` declaration order; `id` first, server fields last |
| MIRR-05 | Attacker-supplied values can never become formulas or links (explicit cell types, formula-prefix guard, illegal XML stripped, length capped) | exceljs string cell type + prefix chars guard + XML control char stripping + D-14 truncation |
| MIRR-06 | Mirror is not re-uploaded when content has not changed | Canonical data hash stored in `mirror_state.contentHash`; skip if hash matches AND ETag matches last write |
| MIRR-07 | Missed mirror update recovered automatically on boot and periodically | Reconcile sweep every 15 min; boot sweep; durable `mirror_state` survives crashes |
| MIRR-08 | Operator can read mirror status and trigger full rebuild | `GET /mirror/status`, `POST /mirror`; API key with `mirror:status`/`mirror:rebuild` grants |
| FND-05 | Single container image with roles `api`, `worker`, `all`, needing only MongoDB | `ROLE` env var; `buildApp` already exists; server.ts start() exposes worker loop |
</phase_requirements>

---

## Summary

Phase 3 adds three things to the existing server: **nested collection names** (slash-separated, routed and stored correctly), a **background mirror worker** (single-writer via Mongo lease, debounced, durable, self-healing), and **xlsx workbook generation** (exceljs, formula-safe, with array sheets and OX-verified TEXTJOIN formulas).

The existing codebase already provides all storage primitives (`WritableMount.write`, `WritableMount.mkdir`), the Mongo client pattern, the integration test harness, and the Fastify app builder. The phase is primarily **additive**: new files in `src/mirror/`, config schema extensions, and targeted changes to `src/collections/routes.ts` (dirty-mark after writes) and `src/server.ts` (ROLE branching + worker start).

**Primary recommendation:** Build in waves — config+validation first, then collection route changes (dirty-mark + nested names), then workbook generation unit tests (exceljs module in isolation), then the worker loop with lease, then operator routes, then the two-instance lease test. The workbook generation is the most complex piece; wrap it in a single `src/mirror/workbook.ts` module tested entirely against in-memory data with no Drive or Mongo dependency.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Dirty-mark after record write | API route handler | — | Only the route knows a record changed; must call `$inc dirtySeq` before replying |
| Debounce decision (is work due?) | Worker poll loop | Mongo `mirror_state` | Durable dirty counter survives crashes; in-process timer is an anti-pattern |
| Lease acquisition / heartbeat | Worker loop | Mongo `leases` collection | Single document, atomic `findOneAndUpdate`, no Redis needed |
| Workbook bytes generation | `src/mirror/workbook.ts` | exceljs | Pure function over data array; no Drive or Mongo dependency |
| Content hash computation | `src/mirror/workbook.ts` | — | Hash the canonical data representation, not the zip bytes |
| Drive upload | Worker loop via `WritableMount` | WebDavAdapter | Re-use existing adapter retry + concurrency |
| Folder creation for nested paths | Worker loop | `WritableMount.mkdir` | MKCOL before first upload for nested collection names |
| Mirror status state machine | `src/mirror/state.ts` | Mongo `mirror_state` | One document per collection; cheap to expose as /mirror/status |
| Operator routes | `src/mirror/routes.ts` | Fastify | Unversioned, alongside /health and /ready |
| ROLE branching | `src/server.ts` start() | `src/app.ts` buildApp | ROLE is a deployment concern; server.ts already owns startup |
| Config validation (mirror section) | `src/config/load.ts` | TypeBox schema | Follows existing issue-list pattern |
| Nested collection name routing | `src/collections/routes.ts` | Fastify prefix | Fastify handles `/v1/events/2026/signups` as a prefix naturally |

---

## Standard Stack

### Core (all already locked in STACK.md / package.json)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| exceljs | 4.4.0 | .xlsx workbook generation | Only maintained Node.js xlsx writer with typed cells, formula support, and multiple sheets; locked in STACK.md |
| mongodb | 7.9.1 | Lease + mirror_state documents | Already in project; single-document atomicity is a core Mongo guarantee |
| fastify | 5.12.8 | Operator routes | Already in project |

`exceljs` is NOT yet in `package.json`. It must be added in the first plan. [VERIFIED: package.json] shows current deps; exceljs is absent. `npm view exceljs version` → `4.4.0` [VERIFIED: npm registry].

### Installation

```bash
pnpm add exceljs@4.4.0
```

No other new runtime dependencies. `pnpm` blocks build scripts by default; exceljs should not require one.

---

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| exceljs | npm | ~8 yrs (first published 2014) | ~2M/wk [ASSUMED] | github.com/exceljs/exceljs | OK | Approved — locked in STACK.md prior research |

Prior STACK.md research (2026-11-21) confirmed `exceljs@4.4.0` on npm, published 2023-10-19, `archiver ^5`, `unzipper ^0.10.11`, `uuid ^8`, `fast-csv ^4` as dependencies. `npm audit` on a scratch install found four moderate findings (minimatch, uuid), both confirmed unreachable. [CITED: STACK.md sources]

**Packages removed due to SLOP verdict:** none  
**Packages flagged as suspicious:** none

---

## Architecture Patterns

### System Architecture Diagram

```
API request (create/replace/patch/delete)
         │
         ▼
 src/collections/routes.ts
   • Validates, writes to MongoDB records_<name>
   • $inc mirror_state.dirtySeq           ◄── NEW: dirty-mark
   • Returns HTTP response
         │
         ▼
 Mongo: mirror_state { dirtySeq, mirroredSeq, dueAt, ... }
         ▲                │
         │                │  worker polls (interval 1-5s)
         │                ▼
 Worker loop (src/mirror/worker.ts)
   • Find collections where dueAt ≤ now AND dirtySeq > mirroredSeq
   • Acquire Mongo lease (src/mirror/lease.ts)
     └─ if E11000: skip (another instance holds it)
   • Stream records from MongoDB (createdAt, _id order)
   • Generate workbook (src/mirror/workbook.ts)
     └─ exceljs: columns, array sheets, formulas, formula guards
   • Compute content hash of canonical data
   • Compare hash vs mirror_state.contentHash
     ├─ same AND Drive ETag matches last write → skip upload
     └─ different OR missing/foreign ETag → upload via WritableMount.write
   • PUT to Drive: <mirror_mount>/<collection>.xlsx
     └─ nested name: MKCOL folders as needed first
   • Update mirror_state: mirroredSeq, contentHash, lastEtag, lastMirroredAt
   • Release / let heartbeat lapse
         │
         ▼
 Drive: <mount>/events/2026/signups.xlsx  (staff open this)

 Reconcile sweep (same worker, every 15min + on boot)
   • Sets dueAt = now for every collection → triggers normal pass
   • Content-hash skip prevents spurious uploads

 GET /mirror/status → reads mirror_state for all collections
 POST /mirror      → sets dueAt = 0, clears contentHash → forces upload
```

### Recommended Project Structure

```
src/
├── mirror/
│   ├── worker.ts       # MirrorWorker: poll loop, reconcile, start/stop
│   ├── workbook.ts     # Pure function: records[] → Buffer + contentHash
│   ├── state.ts        # mirror_state CRUD (findOneAndUpdate helpers)
│   ├── lease.ts        # Acquire / heartbeat / release
│   ├── path.ts         # collectionNameToRelPath(name): string
│   └── routes.ts       # GET /mirror/status, POST /mirror
├── collections/
│   └── routes.ts       # CHANGE: dirty-mark + nested name routing
├── config/
│   └── schema.ts       # CHANGE: mirror section + nested collection name pattern
└── server.ts           # CHANGE: ROLE branching, worker start/stop
```

### Pattern 1: ROLE-based startup branching

```typescript
// src/server.ts — in start()
const role = (options.env ?? process.env).ROLE ?? "all";
// api|worker|all

const app = buildApp({
  ...baseOptions,
  // Worker role still needs health/ready; API routes only for api|all
  collections: (role === "api" || role === "all") ? { config, db } : undefined,
  mirror: { status: mirrorState, role }, // new option for operator routes
});

// Worker loop: start for worker|all
if (role === "worker" || role === "all") {
  const worker = new MirrorWorker({ db, mounts, config, log: app.log });
  worker.start();
  // stop in close() callback
}
```

[ASSUMED] — exact shape of `buildApp` options extension.

### Pattern 2: Mongo Lease + Fencing Token

[CITED: .planning/research/ARCHITECTURE.md Pattern 2]

```typescript
// src/mirror/lease.ts
const me = `${hostname}-${process.pid}`;
const TTL_MS = 60_000;

async function acquire(leases: Collection, name: string): Promise<{ token: number } | null> {
  const now = new Date();
  try {
    const r = await leases.findOneAndUpdate(
      {
        _id: `mirror:${name}`,
        $or: [{ expiresAt: { $lt: now } }, { owner: me }],
      },
      {
        $set: { owner: me, expiresAt: new Date(now.getTime() + TTL_MS) },
        $inc: { token: 1 },
      },
      { upsert: true, returnDocument: "after" },
    );
    return r ? { token: r.token as number } : null;
  } catch (e) {
    if (isDuplicateKey(e)) return null; // someone else won the upsert race
    throw e;
  }
}

// Heartbeat every TTL/3 while upload is in progress
// Commit mirroredSeq only when lease token still matches (fencing)
async function commitMirrored(state: Collection, name: string, seq: number, token: number, ...) {
  await state.findOneAndUpdate(
    { _id: name, leaseToken: token }, // fencing: zombie cannot commit
    { $set: { mirroredSeq: seq, ... } },
  );
}
```

**Fencing honest limit:** A zombie holder could still upload a stale file before the new owner. This self-heals because the reconcile sweep triggers another run. The drive ETag foreign-change detection (D-03) will record and correct it.

### Pattern 3: Durable Debounce in mirror_state

[CITED: .planning/research/ARCHITECTURE.md Pattern 3]

```typescript
// mirror_state document shape (src/mirror/state.ts)
type MirrorState = {
  _id: string;           // collection name
  dirtySeq: number;      // bumped by every record write
  mirroredSeq: number;   // last seq the worker committed
  dueAt: Date;           // debounce: when this collection becomes eligible
  failures: number;      // consecutive failures (for backoff)
  nextAttemptAt: Date;   // backoff deadline
  lastError: string | null;  // error code, never PII
  lastMirroredAt: Date | null;
  contentHash: string | null;  // canonical data hash for skip-decision
  lastWrittenEtag: string | null; // ETag from last successful PUT
  externalChangeAt: Date | null;  // D-03: set when Drive ETag differs
};

// Collection write handler calls this after Mongo insert/replace/patch/delete:
async function markDirty(state: Collection, name: string, debounceMs: number): Promise<void> {
  const dueAt = new Date(Date.now() + debounceMs);
  await state.updateOne(
    { _id: name },
    { $inc: { dirtySeq: 1 }, $max: { dueAt } },
    { upsert: true },
  );
}
// $max dueAt: sliding window (keeps extending as long as writes keep coming)
// Max-wait cap: worker checks if now > firstDueAt + maxWaitMs and forces run regardless
```

**Lag metric:** `dirtySeq - mirroredSeq` and `Date.now() - lastMirroredAt.getTime()`. Cheap to expose in `/mirror/status` and `/ready`.

### Pattern 4: Workbook Generation (exceljs)

```typescript
// src/mirror/workbook.ts
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";

/** XML control characters forbidden in OOXML cell values. */
const ILLEGAL_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF]/g;

/** Formula-injection prefixes per MIRR-05. */
const FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r"]);

function sanitizeString(value: string, maxLen: number): string {
  // Strip XML-illegal characters first
  let s = value.replace(ILLEGAL_XML, "");
  // Truncate
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…[truncated]";
  return s;
}

/** Write a cell safely: never an object, never a formula. */
function setCellValue(cell: ExcelJS.Cell, value: unknown, maxLen: number): void {
  if (value === null || value === undefined) {
    cell.value = null;
    return;
  }
  if (typeof value === "boolean") { cell.value = value; return; }
  if (typeof value === "number") { cell.value = value; return; }
  if (value instanceof Date) { cell.value = value; return; }
  // All other values → string
  const s = sanitizeString(String(value), maxLen);
  // Explicit string cell: exceljs does NOT evaluate plain string cells as formulas.
  // The guard prevents the value from being re-interpreted if the file is exported to CSV.
  if (FORMULA_PREFIXES.has(s[0] ?? "")) {
    // Option: prefix with apostrophe to show user intent ("+" phone number stays legible)
    // At minimum use typed string — exceljs will write it as a string cell, not a formula.
    cell.value = s; // string assignment = string cell type in exceljs
    // shortcut: add leading "'" if decided during implementation — see D-11 Discretion
  } else {
    cell.value = s;
  }
}

export function buildWorkbook(
  collectionName: string,
  schema: CollectionSchema,
  records: RecordDocument[],
  options: { maxCellLen?: number } = {},
): { buffer: Buffer; contentHash: string } {
  // ... (implementation detail for the workbook module)
}
```

**Key exceljs facts (from STACK.md / PITFALLS.md research):**
- Plain string assignment → string cell. NOT a formula. [CITED: exceljs README]
- Object value like `{formula: "=SUM(A1:A2)"}` → formula cell. Never pass user data as an object.
- XML-illegal control chars → workbook Excel "repairs" or refuses. Must strip.
- Cell `result` for formula cells: at Claude's discretion, write a cached result for desktop viewers.
- `workbook.xlsx.writeBuffer()` → Promise<Buffer>. No streaming needed at this scale.
- Zip timestamps in archiver may cause non-identical bytes for the same content. **Solution: hash the canonical data representation (sorted records + columns as JSON), not the bytes.** [ASSUMED: archiver timestamp variability]

### Pattern 5: Content Hash for Skip Decision

```typescript
// Canonical data representation: stable across regenerations
function computeContentHash(records: RecordDocument[], columnOrder: string[]): string {
  // Sort is already stable (D-12: createdAt then _id)
  const canonical = records.map(r => {
    return columnOrder.map(col => {
      // flatten nested for dot columns
      return getNestedValue(r.data, col);
    });
  });
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 32);
}
```

**Why not hash the bytes:** Zip archives have timestamps from `archiver`; same data at different times produces different bytes. Hashing the canonical data array avoids this entirely. [ASSUMED: exceljs/archiver timestamp behavior — no patch verified]

### Pattern 6: Nested Collection Name → Drive Path

```typescript
// src/mirror/path.ts
// D-06: single function owns this rule
export function collectionToRelPath(collectionName: string): string {
  // "events/2026/signups" → "events/2026/signups.xlsx"
  // "contacts" → "contacts.xlsx"
  return collectionName + ".xlsx";
}

// Folders to MKCOL before first upload:
export function collectionToFolderPath(collectionName: string): string | null {
  const slash = collectionName.lastIndexOf("/");
  return slash < 0 ? null : collectionName.slice(0, slash);
}
```

The relative path passed to `WritableMount.write(relPath, body)` goes through `mounts.resolve()` which calls `parseRelativePath(relPath)` — this splits on `/` and validates each segment. Each segment of the collection name matches `MOUNT_NAME_PATTERN` already, so `events/2026/signups.xlsx` splits cleanly into `["events", "2026", "signups.xlsx"]` and passes all checks. [VERIFIED: src/storage/drive-path.ts:14-18 — `parseRelativePath` splits on `/` and runs `checkSegment` on each part]

### Pattern 7: Nested Collection Name Support

**Config schema change** — `src/config/schema.ts`:

```typescript
// New pattern for collection names: allow slash-separated segments
// Each segment matches MOUNT_NAME_PATTERN (^[a-z][a-z0-9-]{0,31}$)
export const COLLECTION_NAME_PATTERN =
  "^[a-z][a-z0-9-]{0,31}(\\/[a-z][a-z0-9-]{0,31})*$";

// In ConfigSchema, change collections key type:
Type.Record(
  Type.String({ pattern: COLLECTION_NAME_PATTERN }),
  ...
)
```

**Route registration** — `src/collections/routes.ts`:

Fastify naturally handles `prefix: "/v1/events/2026/signups"` as a path prefix. The existing `{ prefix: \`/v1/${name}\` }` works unchanged for slash-separated names. No code change needed here for routing itself.

**Reserved-name check** — D-21 applies to first segment only:

```typescript
// src/collections/definition.ts collectionIssues:
const firstSegment = name.split("/")[0];
if (RESERVED_COLLECTION_NAMES.has(firstSegment)) {
  report({ code: "collection.RESERVED_NAME", at: base });
}
```

**MongoDB collection name with slashes** [VERIFIED: manual test this session]:

```
// Test: db.collection("records_events/2026/signups").insertOne({_id:"test"})
// Result: "slash OK"  — MongoDB allows / in collection names
```

Use `records_${name}` unchanged. The slash is preserved. [VERIFIED: manual test 2026-11-22]

**Grant validation** — `src/collections/definition.ts apiKeyIssues`:

The existing check rejects grants where the collection name is not in the loaded collections or where the operation is not in `COLLECTION_OPERATIONS`. Add an allowlist for operator grants:

```typescript
const OPERATOR_GRANTS = new Map([
  ["mirror", new Set(["status", "rebuild"])],
  // extend here for future operational endpoints
]);

// In apiKeyIssues, before the else-if:
const operatorOps = OPERATOR_GRANTS.get(collection);
if (operatorOps && operatorOps.has(operation)) {
  // valid operator grant — no issue
} else if (!collections.has(collection) || !OPERATIONS.has(operation)) {
  issues.push({ code: "apiKey.UNKNOWN_GRANT", at });
}
```

### Pattern 8: Two-Instance Test (MIRR-02)

The two-instance test lives in `test/integration/mirror-lease.test.ts`. It starts **two** service instances pointing to the **same MongoDB database** (same `dbName`) but different WebDAV subfolders (or the same folder is fine since only one should write):

```typescript
// Two instances, same DB, same WebDAV folder, one collection
const instanceA = await mirrorApp({ dbName, ...opts });
const instanceB = await mirrorApp({ dbName, ...opts });

// Trigger a dirty-mark on one instance
await instanceA.fetch("/v1/contacts", { method: "POST", ... });

// Wait long enough for debounce + upload
await new Promise(r => setTimeout(r, debounceMs + 2000));

// Verify: exactly one .xlsx was written (not two conflicting PUTs)
// Verify: Drive has exactly one version of the file (no corrupt interleave)
// Verify: mirror_state.mirroredSeq === dirtySeq
```

This requires a `mirrorApp` test helper that is similar to `collectionsApp` but also starts the worker. The worker's ROLE and debounce timing should be configurable via test options. Use short debounce (100ms) and TTL (500ms) in tests.

### Anti-Patterns to Avoid

[CITED: .planning/research/ARCHITECTURE.md Anti-patterns]

- **Anti-pattern 1: In-process mutex as the only lock.** Correct for one process, wrong during rolling deploys. Always use Mongo lease even if you plan a single replica.
- **Anti-pattern 2: Drive writes from request handlers.** The request handler must only mark dirty. Never call exceljs or upload from a route handler.
- **Anti-pattern 3: `setTimeout` as the source of truth for pending work.** Lost on crash. The durable dirty counter in `mirror_state` is the source of truth; the timer is just a wakeup.
- **Anti-pattern 4: Temp upload + MOVE.** Superseded by D-01 (direct PUT). Do not implement MOVE-based upload.
- **Anti-pattern 5: Passing user data objects to `cell.value`.** `{formula: "..."}`, `{hyperlink: "..."}`, `{richText: [...]}` are all formula/hyperlink injections. Only pass JS primitives (string, number, Date, boolean, null).

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| .xlsx generation | Custom XML/zip writer | `exceljs@4.4.0` | Zip structure, shared strings, number formats, formula refs — all complex |
| Atomic lease acquisition | In-process `Map<name, boolean>` | Mongo `findOneAndUpdate` with `$inc token` | Survives crashes and rolling deploys |
| Retry/backoff for Drive writes | Custom `setTimeout` loop | Existing `WebDavAdapter` (already has `p-retry`) | Concurrency cap, exponential backoff, 429/503 handling already in place |
| Concurrent Drive upload protection | Semaphore in process | Mongo lease (see above) + existing `p-limit` in WebDavAdapter | Cross-process |
| Sheet name truncation with collision suffix | Custom map | Deterministic truncate + stable `~N` suffix from field order | 31-char limit + forbidden chars + collision handling |

---

## Common Pitfalls

### Pitfall 1: exceljs cell value objects from nested JSON

**What goes wrong:** A record field is a nested JSON object. Code does `cell.value = record.data[field]` without extracting a primitive. exceljs interprets `{formula: ...}`, `{hyperlink: ...}`, `{richText: [...]}` as typed cell values — formula injection.

**How to avoid:** Flatten all nested objects to dot-notation columns (D-09) before writing. The workbook builder only receives already-flattened primitive values. The column builder and the cell setter are separate functions; the setter only accepts primitives.

**Warning signs:** TypeScript `unknown` passed to `cell.value` without an `if (typeof value === ...)` guard.

### Pitfall 2: XML-illegal control characters crash Excel

**What goes wrong:** A record string contains `\u0000`–`\u0008`, `\u000B`, `\u000C`, `\u000E`–`\u001F`, or lone surrogates. exceljs writes them into the XML; Excel shows a repair dialog or refuses to open.

**How to avoid:** Strip `ILLEGAL_XML` regex from every string before passing to `cell.value`. Do this in `sanitizeString` before truncation.

### Pitfall 3: Array sheet name collisions / 31-char limit

**What goes wrong:** A deeply nested field path like `address.line_items.description` is 32 chars. D-23 says cut to 31 and add `~N` suffix for stability. If the truncation rule is not deterministic (e.g., depends on field insertion order at runtime), regenerations produce different names → broken formula references.

**How to avoid:** Process fields in schema declaration order (same as column order) so `~N` indices are assigned the same way every time. Build the name→sheetName map once during workbook init; store it in `mirror_state` for reference (not strictly required, but helpful for debugging).

### Pitfall 4: Non-deterministic bytes → content hash always "changed"

**What goes wrong:** Hashing the Buffer bytes of the xlsx file. Because `archiver` sets zip entry timestamps to wall-clock time, the same content regenerated 1 second later produces different bytes → content hash always differs → upload always happens → D-04 skip never fires.

**How to avoid:** Hash the **canonical data representation** (sorted record array serialized as JSON), not the Buffer. Store `contentHash` in `mirror_state`. [ASSUMED: archiver timestamp variability — verify by calling `buildWorkbook` twice with same data and comparing Buffer hashes]

### Pitfall 5: Lease upsert race (E11000)

**What goes wrong:** Two instances both see the lease as expired and both attempt `findOneAndUpdate` with `upsert: true`. MongoDB guarantees only one upsert wins, but the loser gets an E11000 duplicate key error — not a null return.

**How to avoid:** Catch E11000 in `acquire()` and return `null` (same as "someone else holds it"). Use the existing `isDuplicateKey` helper from `src/collections/idempotency.ts`. [VERIFIED: src/collections/idempotency.ts — `isDuplicateKey` function exists]

### Pitfall 6: Zombie writer with stale lease

**What goes wrong:** Instance A holds a lease and starts uploading. The upload takes longer than the TTL (or the heartbeat misses). Instance B acquires the lease with a new token. Instance A finishes the upload and tries to commit `mirroredSeq` — it succeeds because there's no fencing check, overwriting B's correct record.

**How to avoid:** Filter on `leaseToken` in the `commitMirrored` update. Instance A's commit is a no-op if B already has the token. Instance A's upload still landed, but B will overwrite it on the next reconcile (which is fast).

### Pitfall 7: MKCOL for nested paths (D-18)

**What goes wrong:** Calling `WritableMount.write("events/2026/signups.xlsx", buf)` before the folders `events/` and `events/2026/` exist. OX returns 409 Conflict (parent does not exist).

**How to avoid:** Before the first upload of a nested collection, check if the folder path exists (stat) and MKCOL each missing segment. Cache the result in `mirror_state.foldersCreated: boolean`. Re-run MKCOL on a 409 upload failure (idempotent recovery).

### Pitfall 8: config validation — mirror mount not read-write

**What goes wrong:** Deployer sets `mirror.mount: docs` where `docs` is a `read` mount. The worker silently fails on the first upload attempt (or throws `read-only-mount`).

**How to avoid:** Add a startup issue `mirror.MOUNT_NOT_WRITABLE` when the configured mirror mount exists but has `mode: read`. Add `mirror.MOUNT_UNKNOWN` when the mount name is not in `mounts`. Both are caught in the config issue stage before `start()` returns.

---

## Code Examples

### exceljs: add worksheet, typed headers, date cell

```typescript
// Source: exceljs README (github.com/exceljs/exceljs)
import ExcelJS from "exceljs";

const wb = new ExcelJS.Workbook();
wb.created = new Date(0);       // reproducible metadata (optional)
wb.modified = new Date(0);
wb.creator = "";
wb.lastModifiedBy = "";

const ws = wb.addWorksheet("contacts"); // D-24: last segment, ≤31 chars
ws.addRow(["id", "email", "createdAt"]); // header row

// Date cell (D-13)
const row = ws.addRow(["uuid-1", "a@example.com", new Date("2026-01-15T10:00:00Z")]);
const dateCell = row.getCell(3);
dateCell.numFmt = 'yyyy-mm-dd hh:mm:ss'; // UTC display format

const buf: Buffer = await wb.xlsx.writeBuffer() as Buffer;
```

### exceljs: formula cell for array summary (D-11)

```typescript
// Source: D-11 verified in OX on 2026-11-22
// Rows for record "uuid-1": tags sheet rows 2 through 4 (1-indexed, row 1 is header)
const formulaCell = mainWs.getCell(mainRowIndex, tagsColIndex);
formulaCell.value = {
  formula: `_xlfn.TEXTJOIN(", ",TRUE,'tags'!$C$2:$C$4)`,
  result: "", // cached result for desktop viewers (at discretion)
};
```

**Sheet name quoting:** When a sheet name contains spaces, dots, or parentheses, it must be quoted with single quotes in the formula: `'address.lines'!$C$2:$C$4`. ExcelJS does NOT auto-quote — the formula string must include the quotes. [ASSUMED: exceljs formula string passthrough — verify in workbook unit tests]

### Mongo: dirty-mark from route handler

```typescript
// In src/collections/routes.ts, after every successful Mongo write:
// (create, replace, patch, delete)
await mirrorState.updateOne(
  { _id: collectionName },
  {
    $inc: { dirtySeq: 1 },
    $max: { dueAt: new Date(Date.now() + config.mirror.debounce.defaultMs) },
  },
  { upsert: true },
);
// Fire-and-forget is acceptable: the reconcile sweep catches misses (D-16/MIRR-07)
// Use void + catch(log) to avoid unhandled rejection while not blocking the response
```

### Worker poll loop skeleton

```typescript
// src/mirror/worker.ts
export class MirrorWorker {
  #running = false;
  #timer: NodeJS.Timeout | null = null;

  start(): void {
    this.#running = true;
    this.#scheduleReconcile(); // boot sweep
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
      if (!lease) continue; // someone else has it
      try {
        await this.#mirrorOne(name, lease.token);
      } finally {
        // Let the lease expire naturally; heartbeat was running during #mirrorOne
      }
    }
  }
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Temp upload + MOVE for atomicity | Direct PUT (D-01) | Phase 3 discuss-phase | No temp files, no orphan cleanup, Drive identity preserved |
| Separate Reconciler component | Same worker job (D-16) | Phase 3 discuss-phase | Simpler topology; one fewer abstraction |
| Per-collection `mirror: false` opt-out | Mirror always required (D-05) | Phase 3 discuss-phase | Simpler config; no conditional paths |

**Outdated (from ARCHITECTURE.md):**
- Pattern 4 (temp+MOVE): **superseded by D-01**. Direct PUT is the standard.
- Separate Reconciler component: **collapsed into MirrorWorker by D-16**.

---

## Existing Code — Integration Points

These patterns are VERIFIED in the codebase this session and must be followed:

**1. Config issue list pattern** [VERIFIED: src/config/load.ts, src/collections/definition.ts]
- Issues carry `{ code, at }` with JSON pointers only, never config values.
- Exact duplicate issues are suppressed with a `seen Set<string>`.
- Mirror config issues follow the same pattern: `mirror.MOUNT_UNKNOWN`, `mirror.MOUNT_NOT_WRITABLE`, `mirror.REQUIRED` (when collections are defined but mirror section is absent).

**2. `collectionsApp` test helper** [VERIFIED: test/helpers/collections-app.ts]
- Starts the real `start()` from a generated config.yaml.
- Uses `inject("runId")` for database isolation (from global-setup).
- WebDAV data is in `run-${runId}/` subfolder, cleaned up on close.
- Adapt this helper for mirror tests: add mirror config and worker startup. Use `adapterTimings: { retries: 1, minTimeout: 1, maxTimeout: 5 }` to keep tests fast.

**3. `WritableMount` pattern** [VERIFIED: src/storage/mount-view.ts:40-44]
```typescript
async write(rel: string, body: Buffer): Promise<StatEntry>
async mkdir(rel: string): Promise<void>
async stat(rel: string): Promise<StatEntry>
```
The `stat` return has `etag: string | null` — this is the ETag to store in `mirror_state.lastWrittenEtag`. On OX, stat returns a real ETag; on hacdias in tests, it also returns one.

**4. StorageError kinds** [VERIFIED: src/storage/errors.ts — not read but used throughout]
- `not-found`: file/folder does not exist → trigger MKCOL for missing parent
- `conflict`: exists but wrong type (e.g., folder where file expected) → flag in state
- `read-only-mount`: safety net for wrong mount mode

**5. `isDuplicateKey` utility** [VERIFIED: src/collections/idempotency.ts]
Used for Mongo E11000 handling in idempotency store. Reuse for lease acquisition.

**6. Vitest project structure** [VERIFIED: vitest.config.ts]
- Unit tests: `test/unit/**/*.test.ts`
- Integration tests: `test/integration/**/*.test.ts`, `fileParallelism: false`, timeout 30s
- Global setup: `test/integration/global-setup.ts` — waits for MongoDB + WebDAV on 127.0.0.1

**7. RESERVED_COLLECTION_NAMES already includes `mirror`** [VERIFIED: src/collections/definition.ts:12]
No collision possible between the operator route prefix and collection names.

**8. MOUNT_NAME_PATTERN** [VERIFIED: src/config/schema.ts:13]
`"^[a-z][a-z0-9-]{0,31}$"` — the pattern for each slash-segment of a collection name.

---

## Changes Required in Existing Files

| File | Change | Reason |
|------|--------|--------|
| `src/config/schema.ts` | Add `COLLECTION_NAME_PATTERN` (allows slashes); add `mirror` block to `ConfigSchema` and `Config` type; add debounce/reconcile timing fields | D-05, D-15, D-18 |
| `src/config/load.ts` | Add mirror startup issue validation (mount exists, is read-write, required when collections present) | D-05 |
| `src/collections/definition.ts` | Use `COLLECTION_NAME_PATTERN` for name validation; apply reserved-name check to first segment only (D-21) | D-18, D-21 |
| `src/collections/definition.ts` `apiKeyIssues` | Allow `mirror:status` and `mirror:rebuild` grants via `OPERATOR_GRANTS` allowlist | D-22 |
| `src/collections/routes.ts` | Dirty-mark after every successful Mongo write (create/replace/patch/delete); ensure `prefix: /v1/${name}` works with slash names (verify Fastify accepts) | MIRR-01 |
| `src/app.ts` | Add `mirror` options (routes + status reader); conditionally register `/mirror/status` and `POST /mirror` routes | D-22 |
| `src/server.ts` | Read `ROLE` env var; conditionally start `MirrorWorker`; add worker to `close()` teardown; pass mirror config to buildApp | FND-05, D-17 |
| `src/http/health.ts` | Add informational mirror lag to `/ready` response (non-blocking, Drive outage must not fail /ready) | D-16, FND-02 |
| `REQUIREMENTS.md` | Reword MIRR-03 (direct PUT, no temp files) and MIRR-04 (stable schema order, no config mapping) | D-02, D-08 |
| `.planning/ROADMAP.md` | Update Phase 3 success criteria SC3 and MIRR-03/04 wording | D-02, D-08 |

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `archiver` (used by exceljs) writes zip entry timestamps from wall clock, making Buffer bytes non-deterministic across calls | Pitfall 4, Pattern 5 | If bytes are deterministic, hashing the data representation still works (conservative, no harm) |
| A2 | Hashing the canonical data array (not bytes) is sufficient as a "content unchanged" signal for MIRR-06 | Pattern 5 | If column layout changes without data changing, the hash changes — OK, we do want to re-upload on schema change |
| A3 | Fastify `plugin({ prefix: "/v1/events/2026/signups" })` registers `GET /v1/events/2026/signups` and `GET /v1/events/2026/signups/:id` correctly without ambiguity | Pattern 7 | If Fastify mis-parses the prefix, routes 404 — verify in first integration test with a nested collection |
| A4 | exceljs formula strings are passed through unchanged to the xlsx XML (the `formula` property of a cell value object is not re-parsed or escaped by exceljs) | Pattern 4 | If exceljs escapes the formula string, generated formulas may be broken — catch in workbook unit test |
| A5 | The existing `WebDavAdapter` sends `Content-Length` with PUT (not chunked) since it writes from a Buffer | Environment | P-05 from spike confirmed both work; Buffer PUT is confirmed to work |
| A6 | `BuildApp` options can be extended with a `mirror` option without breaking the existing `AppOptions` interface contract | Pattern 1 | Additive extension; TypeScript will catch mismatches at compile time |

---

## Open Questions

1. **Config shape for debounce timing**
   - What we know: D-15 says `config.yaml` (not env), 15s default, 3min max wait; `mirror.debounce.defaultMs` and `mirror.debounce.maxWaitMs` are reasonable names
   - What's unclear: Whether `reconcileIntervalMs` (15min) also lives in `mirror` block or as a separate key
   - Recommendation: Group as `mirror.debounce: { defaultMs, maxWaitMs }` and `mirror.reconcileIntervalMs`; use defaults 15000, 180000, 900000

2. **Column name uniqueness for dot-notation + array fields**
   - What we know: D-09 says nested objects → dots. D-21 says reject ambiguous names at startup.
   - What's unclear: Exact collision scenario (e.g., a field `address.country` as a string AND a nested `address: { country: ... }`) is already prevented by `INVALID_PROPERTY_NAME` (dots in property names are rejected at collection schema time by `unsafeName()` in `definition.ts`). Arrays get separate sheets (D-10), not columns on the main sheet — so there's no collision between a field `tags` (array → sheet) and a column `tags` (would be on main sheet).
   - Recommendation: The existing `INVALID_PROPERTY_NAME` check (rejects names with `.`) prevents the ambiguity. Document this explicitly in `workbook.ts` comments. No new startup check needed beyond what already exists.

3. **Mirror `mirror_state` document per-instance vs shared**
   - What we know: One document per collection, shared across instances (that's the whole point of durable state)
   - What's unclear: Whether `leaseToken` should be stored in `mirror_state` or only in the `leases` collection
   - Recommendation: Store `leaseToken` in `leases` only (the lease document). The `mirror_state` document tracks mirror progress. Keep them separate: the lease is volatile (expires), the state is durable.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| MongoDB | Lease + mirror_state + records | ✓ (Compose stack) | 8.0 | — (required) |
| hacdias/webdav | Integration test WebDAV | ✓ (Compose stack) | v5 | — (required for integration) |
| pnpm | Package install | ✓ | 12.21.0 | — |
| exceljs | Workbook generation | ✗ (not installed) | 4.4.0 (npm) | — (required; must `pnpm add exceljs@4.4.0`) |
| Node.js | Runtime | ✓ | ≥26 (engines field) | — |

**Missing dependencies with no fallback:**
- `exceljs@4.4.0` — not in `package.json`; first plan task must add it.

---

## Security Domain

> `security_enforcement` not explicitly set to false in config.json — section included.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (operator routes) | Existing API key + grant check; `mirror:status`, `mirror:rebuild` grants |
| V3 Session Management | no | No sessions |
| V4 Access Control | yes | Operator routes gated behind API key; worker never exposes records via HTTP |
| V5 Input Validation | yes | Workbook builder sanitizes all cell values; formula prefix guard; XML control char strip; length cap |
| V6 Cryptography | no | No new crypto (content hash uses SHA-256 from `node:crypto`) |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Formula injection via `=SUM(...)` in record field | Tampering | Force string cell type in exceljs; prefix guard for `= + - @ \t \r`; XML char strip |
| Object injection via nested JSON `{formula: ...}` | Tampering | Flatten all data before passing to exceljs; setCellValue accepts only primitives |
| Path traversal via collection name in Drive path | Tampering | Collection names come only from config (not from requests); `mounts.resolve()` validates all segments via `parseRelativePath` → `checkSegment` |
| Zombie worker overwrites newer data | Tampering | Fencing token in `commitMirrored`; zombie commit is a no-op |
| PII leakage in logs | Disclosure | Log collection name and error code only; never log record content, cell values, or truncation content |
| Operator route exposed without auth | Elevation | `requireGrant("mirror:status")` / `requireGrant("mirror:rebuild")` on both routes; same guard as collection routes |

---

## Sources

### Primary (HIGH confidence)
- Codebase reading this session: `src/config/schema.ts`, `src/collections/definition.ts`, `src/collections/routes.ts`, `src/collections/store.ts`, `src/storage/adapter.ts`, `src/storage/mount-view.ts`, `src/storage/mounts.ts`, `src/storage/drive-path.ts`, `src/server.ts`, `src/app.ts`, `src/http/health.ts`, `test/helpers/collections-app.ts`, `test/integration/global-setup.ts`, `vitest.config.ts`, `package.json`
- `.planning/phases/03-mirror-worker/03-CONTEXT.md` — all locked decisions
- MongoDB slash-in-collection-name live test: `records_events/2026/signups` → "slash OK" (2026-11-22)
- npm registry: `exceljs@4.4.0` confirmed current

### Secondary (MEDIUM confidence)
- `.planning/research/ARCHITECTURE.md` via ctx_execute — Pattern 2 (lease), Pattern 3 (durable debounce)
- `.planning/research/PITFALLS.md` via ctx_execute — exceljs injection vectors, XML illegal chars
- `.planning/research/STACK.md` via ctx_execute — exceljs lock, pnpm install command
- `docs/ox-webdav-compatibility.md` via ctx_execute — P-18 (rate limits), P-16 (quota), P-05 (Content-Length), P-09 (LOCK/If not needed), U-01/U-02 (every PUT = new version)

### Tertiary (LOW confidence / ASSUMED)
- A3: Fastify slash-prefix behavior with nested names — assumed from Fastify's route-based architecture; must be confirmed in first integration test
- A4: exceljs formula string passthrough — assumed from exceljs docs; confirm in workbook unit test

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — exceljs locked from prior research, all other deps already in project
- Architecture: HIGH — locked decisions from CONTEXT.md + verified ARCHITECTURE.md patterns
- Pitfalls: HIGH — from verified PITFALLS.md + live codebase reading
- Nested collection names: HIGH — MongoDB slash test passed; Fastify behavior ASSUMED (A3)
- Two-instance test: MEDIUM — approach is well-established; exact helper API is new

**Research date:** 2026-11-22
**Valid until:** 2026-12-22 (exceljs versions are stable; no fast-moving deps added)
