# Phase 3: Mirror Worker - Context

**Gathered:** 2026-11-22
**Status:** Ready for planning

<domain>
## Phase Boundary

A background worker keeps one `.xlsx` per collection in Drive, regenerated from MongoDB after a debounce, written by a single lease-holding writer, safe against formula injection, self-healing after crashes, and observable/rebuildable by an operator. The single image runs as role `api`, `worker` or `all` needing only MongoDB. The mirror is the core purpose of collections: staff work in the Drive `.xlsx`, MongoDB is the system of record behind the API.

This phase also adds **nested collection names** (slash-separated, mapped to Drive folders), pulled in by the user during discussion (D-18..D-21).

</domain>

<decisions>
## Implementation Decisions

### Drive write strategy (MIRR-03, MIRR-06)
- **D-01:** Write the mirror with a **direct PUT** over the final file. No temp upload + MOVE. Rationale (spike P-17, Consequences 2 in `docs/ox-webdav-compatibility.md`): a direct PUT keeps the file's identity, OX version history and share links; temp+MOVE gives the file a new identity on every write. Uploads are small and fast (10 MB in ~0.6 s), so a torn read is accepted as a risk. No temp files exist, so there is no orphan cleanup.
- **D-02:** **REQUIREMENTS.md MIRR-03 and ROADMAP Phase 3 success criterion 3 must be reworded** to "mirror written by a direct PUT per the spike; no temp files" (drop "temp upload then move" and "orphan temp files are cleaned up"). The planner applies this in the first plan, as was done for SEC-07 in Phase 2.
- **D-03:** Foreign change: if the file's current Drive ETag differs from the one the worker last wrote (staff edited, replaced or re-created it), **overwrite with the MongoDB truth and record it** in mirror status and logs (no content, no PII). OX keeps the overwritten version in history. The same rule applies when a staff file with the mirror's name already exists on first write. The README tells deployers to use a dedicated mirror folder.
- **D-04:** Skip the upload when content is unchanged (MIRR-06): deterministic workbook bytes plus a content hash stored in Mongo. Each OX PUT adds a version even when bytes are identical (U-01, U-02), so the skip is essential. If the file is missing in Drive or its ETag differs from the last write, upload even when the hash matches.

### Where mirrors live (MIRR-01)
- **D-05:** The mirror is **required, with no opt-out**. When any collection is defined, a top-level `mirror: { mount: <name> }` is required, and the mount must be `read-write`, or startup fails alongside the other config errors. Every collection is mirrored. There is no per-collection `mirror: false` and no per-collection mount override. — **Reversibility:** one-way — the config format is a published deployer contract (P1 D-16).
- **D-06:** The file path is derived only from the collection name: `<mirror mount>/<collection>.xlsx` (with nested names, `<mount>/a/b/c.xlsx`, D-18). Keep this rule in one function. It is safe because names come only from config and match `MOUNT_NAME_PATTERN` per segment, and no request ever chooses a Drive path.

### Columns and cell format (MIRR-04, MIRR-05)
- **D-07:** Columns: `id` first, then schema properties in schema `properties` order, then `createdAt` and `updatedAt` last. Headers are the raw JSON keys (no `title`). A conflict between `id` and a user property cannot happen: P2 already rejects top-level `id`/`createdAt`/`updatedAt` properties (`RESERVED_PROPERTIES` in `src/collections/definition.ts`).
- **D-08:** **No config column mapping.** MIRR-04 must be reworded to "mirror columns follow the schema in a stable order" (drop "or a config mapping"). The planner applies this together with D-02.
- **D-09:** Nested objects are flattened with dots: `address.country` gets its own column.
- **D-10:** **Arrays get a separate sheet per array.** A scalar array's sheet has `id`, `index`, `value`. An array of objects has `id`, `index` plus one column per object field, flattened like the main sheet. `id` refers back to the record. Sparse is fine.
- **D-11:** The main sheet keeps a column for each array field holding a **generated formula** that summarises the array sheet (joined values, or for object arrays the summary in the same style). Which formula is used is decided by a **human check in research/planning**: the researcher generates candidate `.xlsx` files (e.g. `TEXTJOIN`+`FILTER`, older-compatible alternatives, with and without a cached `{ formula, result }` value in exceljs) and the user opens them in mailbox.org Drive and reports which renders properly. Mark this as a human-action checkpoint. **Fallback** if none renders: server-joined text written as a typed string cell. Generated formulas never embed submitted values (MIRR-05 stays intact).
- **D-12:** Rows are sorted oldest first by `createdAt`, then `id`. The order is stable across regenerations.
- **D-13:** `format: date-time` / `date` fields and `createdAt`/`updatedAt` become real Excel date cells in UTC.
- **D-14:** A value over Excel's 32,767-character limit (or a lower configured cap) is truncated and ends with `…[truncated]`. The truncation count is logged, never the content. The full value stays in MongoDB.

### Timing, reconciliation and roles (MIRR-01, MIRR-07, FND-05)
- **D-15:** The debounce sits in `config.yaml` (not env): default **15 s** after the last write, **max wait 3 min** under constant traffic.
- **D-16:** Reconciliation is **the same worker job**, not a separate component. On boot and every **15 min** (configurable in `config.yaml`) the worker treats every collection as due and runs the normal regenerate-from-MongoDB pass. The content-hash skip (D-04) avoids a Drive write when nothing changed. API writes also trigger the debounced pass in between.
- **D-17:** The role comes from the `ROLE` env var (`api` | `worker` | `all`), default `all`. It is a deployment value, so it sits in env (P1 D-17). A `worker` still serves `/health` and `/ready`, but no API routes.

### Operator API (MIRR-08)
- **D-22:** Operator routes are **unversioned at the root**: `GET /mirror/status` gives every collection's status in one response, and `POST /mirror` triggers a rebuild from MongoDB. They sit alongside `/health` and `/ready` as operational routes. They need an API key, and the grants proposed during discussion were the global `mirror:status` and `mirror:rebuild` (`mirror` is reserved, so it cannot clash with a collection). — **Reversibility:** one-way — route paths and grant strings are part of the public API and config contract.

### Nested collections (pulled into this phase)
- **D-18:** Collection names may be **slash-separated**: the config key `events/2026/signups`, where each segment matches `MOUNT_NAME_PATTERN`. Routes are `/v1/events/2026/signups` and `/v1/events/2026/signups/{uuid}`, and the mirror goes to `<mount>/events/2026/signups.xlsx`, with folders created as needed (MKCOL). Grants read `events/2026/signups:create`. Routing is unambiguous because a segment is at most 32 characters and a UUID is 36. Existing flat collections and URLs are unchanged, so the change is additive. — **Reversibility:** one-way — it extends the public URL contract (P2 D-15) and the config format.
- **D-19:** **No depth limit**, bounded only by URL and path length.
- **D-20:** A collection and a deeper one may share a prefix (`events` and `events/2026`), giving `events.xlsx` next to a folder `events/`.
- **D-21:** The reserved-name check (P2 D-16) applies to the first segment.

### Claude's Discretion
- Rebuild semantics: `POST /mirror` returns 202, bypasses the content-hash skip (forces an upload, so an operator can repair a file broken in Drive), and rebuilds all collections or one when given `?collection=`.
- Status payload per collection: last mirrored time, lag (seconds and pending write count), last error as a code without PII, and the external-change notes from D-03.
- Formula-guard style for values starting with `=`, `+`, `-`, `@`, tab or CR: an explicit string cell type at minimum. Adding a leading `'` is optional (it changes what staff see, e.g. phone numbers `+49…`). Plus illegal XML characters stripped (MIRR-05).
- Drive outage behaviour: backoff via the existing adapter retry. Following ARCHITECTURE.md, `/ready` should not fail on a Drive outage, and mirror health is informational.
- Lease TTL, heartbeat and fencing details (ARCHITECTURE.md Pattern 2), the `mirror_state` document shape (Pattern 3), and the two-instance test design (MIRR-02).
- How a nested name maps to a MongoDB collection name (`records_<name>` with `/` in it: check validity, or encode it), and how a dotted or bracketed property key is kept from producing ambiguous column names (e.g. reject at startup).
- Sheet naming for array sheets within Excel's 31-character, no-`[]:*?/\` limit, and how arrays nested inside arrays are laid out.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements and scope
- `.planning/ROADMAP.md` § Phase 3: goal and success criteria (SC3 and MIRR-03/04 wording to update per D-02, D-08)
- `.planning/REQUIREMENTS.md`: MIRR-01..08, FND-05
- `.planning/PROJECT.md`: constraints (privacy, no PII in logs, portable Mongo subset, single image)

### Design
- `.planning/research/ARCHITECTURE.md`: MirrorWorker data flow, Pattern 2 (lease + fencing token), Pattern 3 (durable debounce in `mirror_state`), anti-patterns (no Drive writes from requests, mirror is never input). Pattern 4 (temp+MOVE) is **superseded by D-01**, and the separate Reconciler is **collapsed into the worker job by D-16**.
- `.planning/research/PITFALLS.md`: formula/CSV injection and exceljs pitfalls
- `.planning/research/STACK.md`: exceljs risk and mitigations (size cap, wrap in one `workbook/` module, exit path)

### Drive behaviour (spike)
- `docs/ox-webdav-compatibility.md`: P-08 (412 on stale If-Match), P-17 (temp+MOVE vs direct PUT), U-01/U-02 (every PUT adds a version, even byte-identical), P-18 (rate-limit headers), Consequences 2

### Prior phase decisions
- `.planning/phases/01-foundations-ox-spike-and-storage-layer/01-CONTEXT.md`: D-16/D-17 (config vs env), D-19 (mount names, no real paths exposed), D-22 (portable Mongo subset)
- `.planning/phases/02-collections-access-policy-and-anonymous-hardening/02-CONTEXT.md`: D-02 (grant strings), D-13 (hard delete), D-15/D-16 (URL shape, reserved names), D-18 (dotted paths)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/storage/adapter.ts` `StorageAdapter`: `stat`, `write`, `mkdir` cover the PUT, ETag check and folder creation. `MemoryAdapter` is for unit tests and `WebDavAdapter` (retry and concurrency already in place) for integration.
- `src/storage/mount-view.ts` / `mounts.ts` / `drive-path.ts`: `WritableMount`, `parseRelativePath` and PathGuard resolve `<mount>/<collection>.xlsx` safely. Mode checks already reject writes to `read` mounts.
- `src/collections/store.ts`: `records_<name>` per collection, and the keyset cursor pattern for streaming records in `(createdAt, _id)` order.
- `src/collections/definition.ts`: `RESERVED_PROPERTIES` and `RESERVED_COLLECTION_NAMES` (already includes `mirror`), plus the name validation to extend for slash segments.
- `src/auth/api-keys.ts`: `KeyStore` checks the exact `${collection}:${operation}` grant, so the format works for nested names and for `mirror:*`.
- `src/http/health.ts`: `/ready` with `driveState()`, which is non-blocking and the place to add informational mirror lag.
- `src/config/load.ts` / `schema.ts`: TypeBox schema and the issue list for the new top-level `mirror` block and the startup checks.

### Established Patterns
- Config issues carry codes and JSON pointers only, never config values (T-01-16).
- No PII in logs. Log `routeOptions.url`, not raw URLs.
- TDD with vitest. Integration runs against the Compose stack (hacdias/webdav + mongo:8.0), never a real Drive.
- Single-document Mongo ops only, with no transactions or change streams (P1 D-22).

### Integration Points
- Collection write handlers (create/replace/patch/delete in `src/collections/routes.ts`) must mark the collection dirty after the Mongo write (`$inc dirtySeq`, push `dueAt`).
- `src/server.ts` / `src/app.ts`: role selection (`ROLE`) decides whether to register API routes and/or start the worker loop.
- `src/collections/routes.ts` registers with `prefix: /v1/${name}`, which needs checking for names with slashes (D-18).

</code_context>

<specifics>
## Specific Ideas

- The user wants to test candidate array-summary formulas by opening generated `.xlsx` files in their mailbox.org Drive and reporting which renders (D-11).
- The user's mental model: "the whole project is a REST API for mailbox.org Drive; MongoDB primarily stores collections to be written to the Drive". The mirror is never optional.

</specifics>

<deferred>
## Deferred Ideas

None. Nested collections → folders came up and was pulled into this phase by the user (D-18..D-21), against the recommendation to defer it.

</deferred>

---

*Phase: 03-mirror-worker*
*Context gathered: 2026-11-22*
