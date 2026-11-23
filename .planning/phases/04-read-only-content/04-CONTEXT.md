# Phase 4: Read-only Content - Context

**Gathered:** 2026-11-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Cached read API over Drive content. Folder listings, `.xlsx` workbooks as JSON records, `.docx` as sanitised Markdown and raw file downloads are all served from configured mounts under `/v1/{mount}/...`. It includes a MongoDB cache keyed on the Drive ETag (TTL, single-flight, ETag/`304`, stale only while Drive is unreachable), pre-parse size and compression limits, extraction of `.docx` images to a configured assets mount, and an operator cache-refresh route. Requirements: READ-01..READ-11, with READ-02, READ-04 and READ-07 reworded (see D-03, D-18, D-15).

</domain>

<decisions>
## Implementation Decisions

### Addressing and URL shape
- **D-01:** **Path-based, with no per-file config.** Any file on a served mount is addressable by path. Mounts sit at the `/v1` root with no `files/`, `sheets/` or `documents/` prefix:
  - `GET /v1/{mount}/{dir}/`: shallow listing of the folder, with each entry's info (name, type file|folder, extension, size, etag, and for `.xlsx` its sheets and row counts, D-07).
  - `GET /v1/{mount}/.../x.xlsx`: every sheet of the workbook as one JSON response.
  - `GET /v1/{mount}/.../x.xlsx/{sheet}`: one sheet (the URL-encoded sheet name, e.g. `systems(0).planets`). This follows the write API's `/v1/{collection}/{id}` pattern, where the last segment selects the item.
  - `GET /v1/{mount}/.../x.docx`: the document as a Markdown JSON envelope (D-16).
  - `GET /v1/{mount}/.../x.docx/images/{n}.{ext}`: an extracted image (D-19).
  - Any other file downloads. `?download` returns the raw `.xlsx`/`.docx` bytes instead of the parsed form.
  — **Reversibility:** one-way. The URL shape is the public API, and it supersedes P2 D-16's `/v1/files|sheets|documents` prefixes.
- **D-02:** **Mounts and collections share one `/v1` namespace.** Startup rejects a clash between a mount name and the **first segment** of any collection name (a mount `events` clashes with the collection `events/2026/signups`, P3 D-18/D-21), and lists it with the other config errors. The reserved names `files`, `sheets` and `documents` are dropped from `RESERVED_COLLECTION_NAMES`. `mirror`, `admin`, `docs`, `health` and `ready` (plus `cache`, D-26) stay reserved for **both** mounts and collections. — **Reversibility:** one-way. Config contract: once deployers choose names, it can't be undone without renames.
- **D-03:** **Every sheet and every column is exposed, always**, including hidden and veryHidden sheets and hidden columns. There is no column config. **REQUIREMENTS.md READ-02 and ROADMAP Phase 4 success criterion 1 must be reworded** to "all sheets and columns are exposed; visibility filtering is deferred", and the "hidden sheets, hidden columns and unconfigured columns never appear" clause is removed. The planner applies the rewording, the same way P3 D-02/D-08 were applied.
- **D-04:** Listings and downloads cover **everything** on the mount (no dotfile, lock-file or extension filtering). Downloads keep `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` (READ-05).

### Access policy
- **D-05:** **Policy is per mount only**: each mount gets `policy: anonymous | apiKey` in `config.yaml`. With **no policy, the mount is not served** (denied), mirroring SEC-01 for collections. API keys grant `{mount}:read` (exact string, no wildcards, P2 D-02). An unknown mount in a grant fails startup. 401/403 come back as problem+json, as for collections. — **Reversibility:** one-way. The grant strings and `policy` key are config contract.
- **D-06:** **All mounts can be served, read-write and the mirror mount included**, but only when a policy is set explicitly (D-05). Authorization matters here, because an anonymous policy on the mirror mount publishes every collection record. Startup **logs a warning** when the mirror mount (or the images mount, D-18) is `anonymous`, and the README warns about it. Startup does not forbid it.

### Listing
- **D-07:** Listings include each `.xlsx`'s sheets with row counts, **taken from the parsed-sheet cache**. A file not yet cached (or whose ETag changed) is parsed during the listing, bounded by the D-23 limits, so cold listings are slower. A file that fails to parse gets the per-item `error` (D-13) in its entry, and the rest of the listing still succeeds.
- **D-08:** The listing envelope follows the collection list shape: `{ items: [...], nextCursor: null }` (shallow only, no pagination).

### Sheet → JSON
- **D-09:** **Rows are rebuilt into nested records, in the same shape as the write API's DTOs.** Dotted headers unflatten into nested objects (`address.country` → `{ address: { country } }`), the inverse of the mirror's flattening (P3 D-09).
- **D-10:** **Array sheets are joined back by the mirror naming convention**, on any workbook that follows it, not only mirror files. A sheet named after a field path of its parent sheet (`tags`, `address.lines`, `systems(0).planets`, P3 D-10/D-23) whose columns start with `id`, `index` is joined into the parent rows by `id`, in `index` order. A scalar array's `value` column becomes the array element, and an object array's other columns become the element's fields (unflattened). Joined sheets **do not appear separately** in the response. The parent's generated `TEXTJOIN` formula column (P3 D-11) is replaced by the real array.
- **D-11:** Keys are the **raw header text**, trimmed (unflattening per D-09 aside). An empty header becomes the column letter (`C`), and a duplicate header gets a suffix (`Email`, `Email_2`).
- **D-12:** **Native JSON typing.** Numbers stay numbers and booleans stay booleans. Dates become ISO 8601 UTC strings. A formula gives its cached result, never the formula text. Rich text becomes plain text, and a hyperlink becomes its display text. An empty cell is `null`, and every key is present on every row. `id`, `createdAt` and `updatedAt` get **no special treatment**: they are plain headers, so a mirror row reads back as `{ ...data, id, createdAt, updatedAt }`, matching `GET /v1/{collection}/{id}`.
- **D-13:** **A header conflict fails fast** (for example, `address` and `address.country` in the same sheet, empty segments as in `a..b`, or a trailing dot). The response is a **server error (500)** carrying **the listing-style envelope with a per-item `error`**: sheets that parsed carry their records, and the failing sheet is `{ name, error: "<message naming the conflicting headers>" }`. Header text is staff-authored structure, so it may appear in the message. Cell values never may.
- **D-14:** Envelopes: a workbook returns `{ items: [{ name, rowCount, items: [record, …] }, …], nextCursor: null }` in workbook order (joined array sheets left out). One sheet returns `{ name, rowCount, items: [...], nextCursor: null }`. Rows after the last non-empty row are trimmed. There is no pagination: the size limits (D-23) bound the payload.
- **D-15:** **A parse failure is served immediately**, for any parse failure on a new file version (header conflict, corrupt `.xlsx`/`.docx`, over a limit): the error response goes out at once, with no fallback to the last good version. **The last good cached version is served only while Drive itself is unreachable** (network, 5xx, timeouts, DriveHealth down). **REQUIREMENTS.md READ-07 and success criterion 4 must be reworded**: "or a file fails to parse" is dropped from the stale-if-error clause.

### Document → Markdown
- **D-16:** `GET …/x.docx` returns a **JSON envelope**, `{ name, markdown }`, as `application/json`, with the same per-item `error` style on failure (D-13). The raw bytes come via `?download`.
- **D-17:** Sanitisation (READ-03) uses an **allow-list of link schemes**: `http`, `https`, `mailto`, plus relative and `#anchor` links. Any other scheme (`javascript:`, `data:`, `vbscript:`, `file:` and the rest) becomes plain text. **No raw HTML** in the output: an element turndown can't express is reduced to its text. Tables go through `turndown-plugin-gfm`. Whether to allow `tel:` is Claude's discretion.
- **D-18:** **Embedded images are extracted to Drive.** A top-level `images: { mount: <name> }` (like `mirror: { mount }`) names a **read-write** assets mount, and startup fails if it isn't read-write. Images are written to `<images mount>/<source mount>/<doc path>.images/<n>.<ext>`, so documents on read mounts work too, and staff can see the files. **Without an images mount, images are dropped** and their alt text kept. **REQUIREMENTS.md READ-04 and success criterion 2 must be reworded** from "dropped or inlined up to a size cap" to "extracted to a configured assets mount, else dropped". — **Reversibility:** costly. A config key, a Drive layout staff will see, and published image URLs.
- **D-19:** **Image links inherit the document's policy.** The Markdown references `/v1/{doc mount}/.../x.docx/images/<n>.<ext>`, which the API serves by reading the file from the images mount, with the document mount's policy, an ETag and `nosniff`. The images mount's own policy (D-05) controls direct browsing of `/v1/{images mount}/...` only.
- **D-20:** **Image sync on re-parse:** an image is written only when its bytes differ (content-hash skip, like P3 D-04, because every OX PUT adds a version). Images no longer in the document are deleted. Writes run inside the single-flight refresh (D-22), so concurrent reads never write twice. A failed image write must not block serving the Markdown: the link is dropped for that parse and the failure is logged without content. The exact behaviour is the planner's call.

### Cache, HTTP caching and refresh
- **D-21:** **TTL** is global, `cache: { ttl: 5m }` in `config.yaml`, with an optional per-mount `ttl` override. Within the TTL, there is no Drive round trip. After it, the next request does a stat (PROPFIND). If the ETag is unchanged, the TTL is extended with no download. If it changed, the file is downloaded and parsed. The cache key is the Drive ETag (`lastModified` is `null` on OX, C-1).
- **D-22:** **Single-flight** (READ-08): one Drive refresh per expired entry, while concurrent requests wait for its result. The planner chooses how (in-process, and/or a Mongo lease like `MirrorLease` when several API replicas run).
- **D-23:** **Limits** are global defaults, overridable in config: `limits: { maxFileBytes: 10 MiB, maxUncompressedBytes: 100 MiB, maxCompressionRatio: 100, maxDownloadBytes: 25 MiB }`. The stat size is checked before download, and the zip central directory before exceljs or mammoth opens the file (READ-10). Over a limit, the D-13 envelope is returned with a size-limit message. Downloads are capped by `maxDownloadBytes` (matching `DEFAULT_MAX_READ_BYTES`).
- **D-24:** **Cache-Control is policy-aware.** `anonymous` mounts send `public, max-age=<ttl>`. `apiKey` mounts send `private, no-cache`, and the client revalidates with the ETag for a cheap `304`. Response ETags combine the Drive ETag with the representation (listing, workbook, sheet, markdown, download, image), so the JSON and raw forms never share a validator (READ-09).
- **D-25:** **Folder listings are cached** (TTL, like sheets). **Plain downloads are not cached in MongoDB**: they stream from Drive each time, and a conditional request still gets `304` from the stat/listing ETag.
- **D-26:** **Operator refresh** (READ-11): `POST /cache/refresh` with body `{ mount, path }`, unversioned at the root next to `/mirror` (P3 D-22 style). Grant: global `cache:refresh`. It forces a stat and re-parse of a sheet, document or listing and returns the fresh result's status or the D-13 error. `cache` joins the reserved names (D-02). — **Reversibility:** one-way. The route path and grant string are public contract.

### Claude's Discretion
- Whether `tel:` links are allowed (D-17).
- The 5xx status for parse failures (500 by default, D-13). Keep it consistent across sheets, docs and listings.
- The single-flight mechanism (D-22). The exact Markdown/turndown rules beyond D-17.
- Exact names of the new config keys, as long as they follow existing schema conventions (`cache`, `limits`, `images`, mount `policy`/`ttl`).
- How OpenAPI documents the dynamic `/v1/{mount}/*` paths.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements and roadmap
- `.planning/REQUIREMENTS.md`: READ-01..READ-11 (READ-02, READ-04 and READ-07 to be reworded per D-03, D-18, D-15)
- `.planning/ROADMAP.md` §Phase 4: success criteria 1, 2 and 4 to be reworded to match
- `.planning/PROJECT.md`: constraints (privacy, no PII in logs, least privilege on Drive)

### Prior phase decisions
- `.planning/phases/01-foundations-ox-spike-and-storage-layer/01-CONTEXT.md`: D-16..D-19, config contract and mount addressing
- `.planning/phases/02-collections-access-policy-and-anonymous-hardening/02-CONTEXT.md`: D-01..D-04 (API keys and grants), D-15/D-16 (route shape and reserved names, superseded in part by D-01/D-02 here), D-19 (list envelope)
- `.planning/phases/03-mirror-worker/03-CONTEXT.md`: D-04 (content-hash skip), D-07..D-11 and D-23/D-24 (mirror workbook layout that D-09/D-10 invert), D-18 (nested collection names), D-22 (operator routes and grants)

### Drive behaviour
- `docs/ox-webdav-compatibility.md`: Consequences §1 (ETag as validator), C-1 (`lastModified` null on OX), C-2 (NFD names), P-06/P-07 (ETag stability, If-None-Match), and versions on every PUT (relevant to D-20)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/storage/mount-view.ts` (`MountView`, `ReadableMount`, `WritableMount`): read, stat and list per mount, with the mode enforced. Use it for reads and for image writes to the images mount.
- `src/storage/adapter.ts` `StatEntry` (`etag`, `lastModified`, size) and `DEFAULT_MAX_READ_BYTES`: the cache key and the download cap.
- `src/storage/drive-health.ts` `createDriveHealth`: the "Drive unreachable" signal that gates stale serving (D-15).
- `src/storage/memory-adapter.ts` `MemoryAdapter`: unit tests without WebDAV.
- `src/auth/api-keys.ts` `KeyStore`: exact-grant checks. Extend it for `{mount}:read` and `cache:refresh`.
- `src/mirror/columns.ts`, `src/mirror/sheet-names.ts`, `src/mirror/workbook.ts`: the mirror's flattening and sheet-naming rules, which the D-09/D-10 unflattening must invert. Share helpers or test against them, so the round trip of mirror → read gives write DTOs.
- `src/mirror/lease.ts` `MirrorLease`: a model for a Mongo-backed single-flight lease, if one is needed.
- `src/http/` `problem`, `PROBLEM_JSON`: 401/403/404 stay problem+json. Only parse failures use the D-13 envelope.
- `src/collections/definition.ts` `RESERVED_COLLECTION_NAMES`: edit per D-02. `src/collections/routes.ts` `toRecord` and the list `{ items, nextCursor }` are the DTO shapes to match.

### Established Patterns
- Config is validated with TypeBox + Ajv, and every issue is reported in one startup failure (P1 D-16). Mount name pattern `MOUNT_NAME_PATTERN`.
- Paths are never logged (`ResolvedPath` custom inspect, P1 D-19). The no-PII logging harness applies.
- One encapsulated Fastify plugin per route group. Operator routes sit at the root (`src/mirror/routes.ts`).
- TDD (RED → GREEN → REFACTOR). Integration tests run against the Compose stack (hacdias/webdav + mongo:8.0), with synthetic fixtures only.

### Integration Points
- `src/app.ts` `buildApp`: register the mount read plugin under `/v1` alongside the collections. Routing must keep `/v1/{collection}` and `/v1/{mount}/*` apart (D-02 guarantees no name overlap).
- `src/config/schema.ts`: mount `policy` and `ttl`, top-level `cache`, `limits`, `images`, and the clash and reserved-name checks.
- `ROLE` (P3 D-17): read routes are API routes, so `worker` serves none.

</code_context>

<specifics>
## Specific Ideas

- Sheet reads should return the **same structure as the write API's request/response DTOs**, so a mirror workbook read through the API looks like `GET /v1/{collection}` output (D-09..D-12).
- The user's original URL sketch: `GET /v1/{dir}/` lists with info (extension, size, row counts), `GET /v1/{dir}/{subdir}/{file.xlsx}` returns all sheets in one JSON, and `GET /v1/{dir}/{subdir}/{file.xlsx}/{sheet}` returns one sheet.
- Authorization matters: serving the mirror mount must be an explicit choice.

</specifics>

<deferred>
## Deferred Ideas

- Query parameters to hide hidden sheets and columns, or system-added columns (`id`, `createdAt`, `updatedAt`, `index`, `value`): a later version (D-03).
- Recursive listings and listing pagination: not requested. Shallow only, for now.

</deferred>

---

*Phase: 04-read-only-content*
*Context gathered: 2026-11-23*
