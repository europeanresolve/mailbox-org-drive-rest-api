# Pitfalls Research

**Domain:** REST API over a mailbox.org Drive (Open-Xchange App Suite WebDAV) with MongoDB records, a one-way `.xlsx` mirror, `.xlsx`→JSON and `.docx`→Markdown conversion, and anonymous form-submission endpoints
**Researched:** 2026-11-21
**Confidence:** MEDIUM overall. Library and security findings are mostly HIGH/MEDIUM. **OX/mailbox.org WebDAV behaviour is LOW: no OX documentation could be reached, so every OX-specific claim below is a hypothesis for the Phase 0 spike, not a fact.**

Confidence tags used below: `[HIGH]` read in an official/primary source this session; `[MED]` secondary source or well-established library behaviour; `[LOW]` inference or unverified, to be settled by the spike or a fixture test.

Phase keys: **P0** = WebDAV/OX spike, **P1** = Foundation, **P2** = Collections + mirror (forms first), **P3** = Read-only content (sheets, documents, files).

---

## Critical Pitfalls

### Pitfall 1: Building on WebDAV semantics that OX does not honour (locks, If-Match, ETag)

**What goes wrong:**
The adapter is designed around textbook RFC 4918 behaviour: `LOCK` to get a single writer, `If-Match` for compare-and-swap uploads, ETag as a stable content fingerprint. On OX's `webdav.infostore` servlet some or all of these misbehave, and the failure shows up as lost updates or endless cache refreshes in production, not in tests, because the local test WebDAV server (Apache mod_dav, SabreDAV, WsgiDAV) behaves differently.

**Why it happens:**
Developers test against the Docker WebDAV server and assume it represents OX. mailbox.org's own Linux guide tells davfs2 users to set `if_match_bug 1` and `use_locks 0` `[HIGH]`, which is a strong hint that If-Match and locking are unreliable on this server. A Cryptomator user also reported a 412 on an `If-None-Match` revalidation of an unchanged file `[LOW]`. A user forum thread reports HTTP/2 401s with rclone even on the base URL `[LOW]`.

**How to avoid:**
- Phase 0 spike produces a written compatibility matrix and sanitized, synthetic XML fixtures of real OX responses. Matrix rows: ETag changes on content change / not on PROPFIND / not on rename; ETag format (quoted, weak, version-suffixed); `If-Match` and `If-None-Match` on PUT and GET; `LOCK` support; `getlastmodified` resolution; `Depth: 1` vs `infinity`; `MOVE` with `Overwrite: T/F`; `COPY`; `MKCOL` on existing; behaviour of `DELETE` (trash?); error codes for quota (507?), name collisions, forbidden characters.
- Treat the ETag as an opaque string compared only for equality. Build a `version` token from `(etag, getlastmodified, getcontentlength)`; if the spike shows ETag is unstable (changes with no content change), fall back to `(lastmodified, size)` plus a content hash recorded on first fetch.
- Do not rely on locks or `If-Match` for correctness. Single-writer is enforced inside the app (Pitfall 5), and uploads are verified by re-stat.
- Run one `StorageAdapter` contract test suite against both the Docker WebDAV server (CI) and, manually and opt-in, a dedicated test account on a real Drive. This does not conflict with "integration tests never use a real Drive" because it is a manual conformance run with synthetic data.
- Use HTTP/1.1 with keep-alive and a small connection pool (2-4 per origin); set an explicit connect, headers and body timeout; send a descriptive `User-Agent` with a contact address.

**Warning signs:**
Cache refreshes every poll despite no edits; 412/409/423 on writes that worked locally; 401 right after a successful request; tests green but first real-Drive run fails.

**Phase to address:** P0 (matrix + fixtures), P1 (adapter contract tests, retry policy).

---

### Pitfall 2: "Upload to temp name, then MOVE" is not atomic on OX, and leaves debris

**What goes wrong:**
The mirror is written as `mirror.xlsx.tmp` then `MOVE`d over `mirror.xlsx`. Possible outcomes on OX `[LOW]`, all to be tested: `MOVE` over an existing file returns 412/403/409 unless `Overwrite: T` is honoured; the overwrite creates a new version rather than replacing; a destination in the same folder is treated as a rename with different versioning than an overwrite; the temp file is visible to staff and to Drive sync clients and mail notifications; orphaned temp files accumulate after crashes and go to trash/versions.
A retried `MOVE` after a timeout returns 404 (source already gone because the first attempt succeeded) and the app wrongly reports failure and re-uploads.

**Why it happens:**
POSIX rename atomicity is assumed to transfer to WebDAV. RFC 4918 says MOVE is copy + delete with consistency maintenance, not an atomic rename `[MED]`; atomicity is up to the server.

**How to avoid:**
- Spike decides between (a) temp + `MOVE Overwrite:T` and (b) plain `PUT` over the target. For a file only the service writes and staff only open read-only, plain `PUT` plus read-back verification (stat size/ETag, optionally GET and compare hash) may be simpler and equally safe. Do not adopt temp+MOVE just because the requirements say so; adopt it only if the spike shows OX serves the old file until the MOVE completes and creates no extra junk.
- If temp+MOVE is kept: temp name in the same folder with a unique suffix and a prefix the listing endpoints filter out; always send `Overwrite: T` explicitly; treat 404 on a retried MOVE as "maybe succeeded" and resolve by stat of destination (ETag/size/hash match) before retrying; on startup and on a schedule, delete orphaned temp files older than N minutes.
- Always send `Content-Length` (xlsx mirrors are small; buffer them). Some servers reject chunked PUT with 411 `[LOW]`; spike must test.
- Never fail a form submission because the mirror failed (Pitfall 5/6).

**Warning signs:**
`*.tmp` files in staff's Drive; mirror "version history" shows many identical versions; intermittent 404 on MOVE; staff report seeing a half-written or zero-byte mirror.

**Phase to address:** P0 (decide mechanism), P2 (implement + orphan cleanup).

---

### Pitfall 3: Mirror regeneration amplifies every write into Drive versions, trash, quota use, and rate-limit exposure

**What goes wrong:**
Each overwrite creates a new Drive version and keeps old ones (project notes say this appears true; unverified). A spam burst or a chatty debounce turns tens of writes into hundreds of versions of a file that contains personal data, exhausts quota (507/403 that nobody sees), and generates request volume against a provider that publishes no limits and whose Business terms (§6 misuse, §7(3) two-week termination) give it an easy reason to cut you off `[HIGH]` per PROJECT.md.
It also makes the v2 erasure promise harder: every old version and trash entry still contains the person's data.

**Why it happens:**
Mirror trigger is coupled to the write rate; output bytes differ every run (the xlsx core properties embed created/modified timestamps and exceljs may include a generated date), so "skip if unchanged" by byte comparison never fires.

**How to avoid:**
- Decouple: writes only mark a collection dirty in MongoDB; a scheduler regenerates at most once per `minInterval` (e.g. 60 s) with a `maxWait` so continuous writes cannot starve the trailing edge.
- Make the output deterministic: set `workbook.created`/`modified` to the newest record `updatedAt`, fixed `creator`, stable column and row order. Compare a hash of the *row data* (stored in Mongo mirror-state) and skip the upload when unchanged.
- Global request budget in the adapter (token bucket, default ~1-2 req/s, concurrency 2); all callers go through it. Exponential backoff with jitter on 429/503/ECONNRESET, honour `Retry-After`.
- One workbook per collection (small blast radius, independent debounce); a single workbook with all collections regenerates everything on any write.
- Spike measures whether version history and trash grow on overwrite, and what a delete does. Record the result so v2 erasure design starts from facts. For v1: never use the Drive as scratch space; never write the same bytes twice.

**Warning signs:**
Drive quota shrinking faster than record volume suggests; version list of the mirror is long; any 429/503; the mirror's "modified" time changes with no data change.

**Phase to address:** P0 (measure), P2 (dirty flag, deterministic output, hash skip, request budget in P1).

---

### Pitfall 4: Path encoding, href matching and URL joining bugs around names like `Userstore/Last, First`

**What goes wrong:**
Several distinct bugs share one root cause: paths are treated as strings.
- `new URL('/Userstore/Last, First/file.xlsx', 'https://dav.mailbox.org/servlet/webdav.infostore/')` silently discards the `/servlet/webdav.infostore/` base because the path starts with `/` `[HIGH]` (WHATWG URL semantics). Requests go to the wrong URL and return 404.
- Spaces, commas and non-ASCII characters are encoded differently between request and PROPFIND `href` response (`%20` vs `+`, `%2C` vs `,`, absolute vs path-only href, with/without the servlet prefix, trailing slash on collections), so comparing `href === requestedPath` fails and the entry list looks empty or the folder is listed as its own child.
- Unicode normalisation: names uploaded from macOS arrive NFD, typed names NFC; `Müller` configured in YAML does not match `Müller` on Drive `[MED]`.
- Double decoding: Fastify decodes a route param, the app decodes again (`%252e%252e` → `..`).
- OX path segments for personal data (`Last, First`) are themselves personal data (Pitfall 9).

**How to avoid:**
- One `DrivePath` value object: segments are an array of decoded strings; encode each segment with `encodeURIComponent` (and nothing else) when building a URL; join onto a base that is parsed once, with the base path preserved (`base.pathname.replace(/\/$/, '') + '/' + encoded`).
- Parse PROPFIND hrefs by `new URL(href, base)`, decode each segment once, strip the base path, then compare segment arrays after NFC normalisation. Skip the first (self) entry by comparing resource identity, not strings.
- Mount config stores decoded names; fixtures contain commas, spaces, `&`, `+`, `#`, `%`, quotes, umlauts, emoji, NFD/NFC pairs.
- Case sensitivity of OX names is unknown `[LOW]`: spike; if case-insensitive, treat names that differ only by case as collisions.

**Warning signs:**
404 on a folder that exists in the web UI; listing returns the folder itself; works for `Folder` fails for `Last, First`; works on Docker WebDAV, fails on OX.

**Phase to address:** P0 (observe real hrefs), P1 (DrivePath + fixtures).

---

### Pitfall 5: "Single-writer" that is only a debounce timer in one process

**What goes wrong:**
With a second replica (rolling deploy, autoscale, a restart overlap) two processes regenerate the same mirror concurrently. A slower, older snapshot can overwrite a newer one (last-writer-wins on stale data); two temp files collide; the debounce state is lost on crash so the last writes before a restart never reach the mirror.

**Why it happens:**
In-process mutex + `setTimeout` feels like a lock. Distributed correctness needs a lease with fencing, and WebDAV locks cannot be relied on (Pitfall 1).

**How to avoid:**
- Persisted mirror state per collection in MongoDB: `{ dirtySeq, writtenSeq, lease: {owner, expiresAt, token} }`. Writers bump `dirtySeq` atomically (`$inc`) in the same operation as the record write.
- Regeneration acquires the lease with `findOneAndUpdate` (condition: no lease or expired), renews it, reads records *after* acquiring, uploads, then sets `writtenSeq = seqReadAtStart` only if the lease token still matches. Single-document atomic ops only; no transactions (Pitfall 12).
- Lease expiry shorter than a hung upload can cause a zombie writer: include the lease token / generation in the temp filename and re-check the lease immediately before the final MOVE/PUT.
- On boot, reconcile: any collection with `dirtySeq > writtenSeq` is scheduled. Use a Mongo unique index or advisory doc to make "only one scheduler loop active" explicit.
- Alternative accepted by the project: document "run exactly one replica" and enforce it with the same lease (a second instance logs and refuses to run the mirror loop). Either way the lease is required.
- Always regenerate the entire workbook from MongoDB; never read-modify-write the existing xlsx.

**Warning signs:**
Mirror row count lower than collection count after a deploy; mirror flips between two states; two temp files with different suffixes in the folder.

**Phase to address:** P2 (design in the plan, test with two app instances in integration tests).

---

### Pitfall 6: User-controlled values corrupting or hijacking the `.xlsx` mirror

**What goes wrong:**
Anonymous visitors write the content that staff then open in Excel.
- `exceljs` interprets object-shaped cell values: `{formula: ...}`, `{hyperlink, text}`, `{richText: [...]}`, `{error: ...}` `[HIGH]` (library README). If a record field is a nested JSON object and is passed to `cell.value`, a submitter could inject a formula or hyperlink. Plain strings are written as string cells (a string beginning `=` is not evaluated by Excel as written by exceljs `[MED]`, but verify with a fixture, and the same text becomes a formula the moment staff paste it to CSV or retype it).
- XML-illegal control characters (`\u0000-\u0008`, `\u000B`, `\u000C`, `\u000E-\u001F`, lone surrogates) produce a workbook Excel "repairs" or refuses to open `[MED]`.
- Cells over 32,767 characters, sheet names over 31 characters or containing `[]:*?/\`, more than 1,048,576 rows `[HIGH]` (Excel limits).
- A flood of spam rows makes the in-memory exceljs writer huge.

**How to avoid:**
- Column serializer is an explicit allow-list: coerce to `string | number | boolean | Date | null` by schema type; objects/arrays are `JSON.stringify`-ed or joined by a defined rule documented per collection; never pass user objects into `cell.value`.
- Strip illegal XML chars and truncate to 32,767 with a visible marker. Sheet and file names come from config, validated against `^[A-Za-z0-9 _-]{1,31}$`, never from requests.
- Optional config: prefix `'` (or a leading space) on text starting `= + - @ \t \r` for collections whose mirror may be exported to CSV. Make it a documented default decision.
- Hard cap rows per collection mirror; above it, switch to `WorkbookWriter` streaming or stop mirroring and alert.
- Test fixture: record values `=HYPERLINK("http://x","y")`, `=cmd|' /C calc'!A0`, `{"formula":"1+1"}`, `\u0000`, 40k-character string, emoji, RTL text; open result in LibreOffice headless and re-read with exceljs.

**Warning signs:**
Excel "We found a problem with some content" on open; unexpected blue underlined cells; mirror generation throws on a particular record and blocks all subsequent mirrors (poison record: isolate and skip with an error counter, never fail the whole mirror silently).

**Phase to address:** P2.

---

### Pitfall 7: Anonymous write endpoints: spam, quota and abuse amplification

**What goes wrong:**
A public POST endpoint on a non-profit's website is a spam magnet. Consequences here are worse than usual: spam fills MongoDB, drives mirror regeneration (Pitfall 3), and reaches staff's spreadsheet. Rate limiting is misconfigured in one of three ways.
- `@fastify/rate-limit` keys by `request.ip`; behind Kong/nginx without `trustProxy`, every client shares the proxy IP (one bucket, self-DoS); with `trustProxy: true`, a client can forge `X-Forwarded-For` and bypass the limit `[MED]`.
- The default store is per-process memory, so N replicas allow N times the limit `[HIGH]` (README).
- Limits are per-IP only; a botnet or IPv6 /64 rotation passes unnoticed, and no global ceiling exists.

**How to avoid:**
- Per-collection limits with layered controls: body limit (Fastify default is 1 MiB; set per route to a few KiB), `additionalProperties: false`, `maxLength`/`maxItems` on every string/array, per-IP limit, a global per-collection ceiling (circuit breaker: after N records per hour return 429/503 and alert), and a max-records-per-collection cap.
- Set `trustProxy` to the exact proxy hop count or CIDR; integration-test by sending a forged `X-Forwarded-For` through the reference Kong config and asserting the limit still bites. Key IPv6 on /64.
- Use the Mongo-backed or Redis-backed store, or document "in-app limiter assumes one replica; the gateway is the real control".
- Honeypot field and minimum-time-to-submit check are cheap; define a pluggable `verifyChallenge` hook (Turnstile/hCaptcha/ALTCHA token) as an option, off by default, so adopters are not stuck when spam arrives.
- Idempotency: accept an optional client-generated `Idempotency-Key` to stop double-click duplicates.
- CORS: explicit allow-list of origins per collection; no wildcard on apiKey routes. Anonymous submissions from browsers cannot carry secrets: document that apiKey routes are server-to-server only.
- Respond 201 only after the Mongo write; mirror failure never changes the response.

**Warning signs:**
Rate-limit 429s attributed to a single IP that is actually the gateway; records created at a steady rate overnight; records with the same text from many IPs.

**Phase to address:** P1 (rate-limit plumbing, trustProxy), P2 (collection ceilings, honeypot/challenge hook).

---

### Pitfall 8: Silent coercion and runtime-schema validation traps (Ajv/Fastify, Mongo operator injection)

**What goes wrong:**
- Fastify's built-in Ajv defaults (`coerceTypes: 'array'`, `removeAdditional: true`, `useDefaults: true`) silently change submitted data: `"123"` becomes `123`, unknown fields are dropped, scalars are wrapped in arrays `[HIGH]` (Fastify docs behaviour, long-standing). Stored records no longer equal what was validated or what the JSON Schema promises.
- Collection schemas are loaded from config at runtime, so route-level static schemas cannot express them; developers either skip validation or compile the schema per request (slow, memory leak).
- Ajv compiles `pattern` as regular expressions: an adopter-supplied pattern run on anonymous input is a ReDoS vector. `$ref` to remote URLs and `$data` widen the surface. Ajv's default draft is 07, not 2020-12 `[MED]`.
- Query filters on "indexed fields": passing a parsed query object into `find()` allows `?email[$ne]=` or `$where`-style injection if a nested-query parser is used `[MED]`.
- PATCH semantic ambiguity: JSON Merge Patch (null deletes, arrays replace) vs JSON Patch. Validating the patch instead of the merged document lets invalid records in.
- Pagination with `skip` degrades and is unstable under concurrent inserts; sort on `createdAt` has ties.

**How to avoid:**
- Dedicated Ajv instance for records: `strict: true`, `coerceTypes: false`, `removeAdditional: false`, `useDefaults: false`, `allErrors: false` for anonymous routes (cheaper), no remote `$ref`; compile each collection once at boot and cache; fail fast at startup on a bad schema. Pick one dialect and state it.
- Require `maxLength` before `pattern` in anonymous schemas (lint at startup, warn on patterns with nested quantifiers or use `re2`).
- Query: allow-listed fields from the collection config, typed operators (`eq`, `gte`, `lte`, `in`) in a fixed grammar; build the Mongo filter object yourself; reject unknown params; cap `limit` (e.g. 100).
- Cursor pagination on `(createdAt, _id)`; return an opaque cursor; no `skip`.
- PATCH = RFC 7396 merge-patch applied to the stored doc, then validated as a whole; use optimistic concurrency (`version` field or ETag via `If-Match`) so concurrent patches do not lose updates.

**Warning signs:**
Numbers stored as strings or vice versa; fields vanish; a collection with 100k records and slow list; validation errors echoing user input in logs (Pitfall 9).

**Phase to address:** P1 (Ajv/validation policy, query grammar), P2.

---

### Pitfall 9: Personal data in logs, errors, URLs and paths

**What goes wrong:**
"No personal data in logs" is a stated constraint, and it is violated by defaults:
- pino/Fastify request logging includes `url` with query strings (filters like `?email=...`), headers (`authorization`, API keys, cookies) and, if enabled, bodies.
- Ajv validation errors can carry the offending value (`verbose`), and error handlers log `err.message`.
- MongoDB duplicate-key errors embed the key value: `E11000 duplicate key error ... dup key: { email: "x@y.z" }` `[MED]`.
- WebDAV errors and adapter debug logs include the path, and in this domain the path can be a person's name (`Userstore/Last, First`).
- Config dumps at startup include the WebDAV app password and API key hashes.
- Reverse proxies and gateways (Kong access logs) log query strings and, with some plugins, bodies; the reference config must not.

**How to avoid:**
- Custom pino serializers: `req` = `{method, route pattern, requestId}` (route template, not raw URL); `res` = status; `err` = `{type, code, requestId}` with message stripped for Mongo and Ajv errors. `redact` for `*.authorization`, `*.apiKey`, `*.password`, `req.headers`. Never log bodies.
- Path logging policy: log mount name + a hash/short id of the relative path, not the path.
- API keys only in `Authorization`/`X-API-Key` header, never query string.
- Startup config logging prints keys with values replaced by `[set]`.
- CI canary test: submit a record containing a synthetic canary string (`CANARY-7f3a@example.invalid`), exercise error paths (duplicate key, invalid schema, bad filter, WebDAV 404, WebDAV 401), capture all stdout/stderr, assert the canary is absent. Run it in the integration suite.
- Document that downstream error trackers, APM and gateway logs inherit the problem.

**Warning signs:**
Any `body`, `query`, email-like or name-like string in `docker logs`; log lines with full `Userstore/...` paths.

**Phase to address:** P1 (logger and error serializer, canary test harness), P2 (extend canary to each new error path).

---

### Pitfall 10: Cache stampede, publish-in-progress edits, and "last good" loss on TTL expiry

**What goes wrong:**
- Every reader arriving after the 5 minute TTL triggers a PROPFIND/GET; with N concurrent visitors and M replicas this is a burst against a provider with unpublished limits. Cold start after a deploy (empty cache) is the worst case.
- Staff edit in the OX editor, which autosaves; the poller publishes half-written content within one TTL. A non-atomic upload by a desktop client can also expose a truncated `.docx`/`.xlsx`.
- A parse failure on a truncated file replaces the good cache entry with an error, taking the page down.
- Drive outage or 401 (expired app password) turns into 500s for every visitor.
- The 16 MB BSON document limit is hit by a big sheet or a doc with inline base64 images stored as one cache document `[HIGH]`.
- Converter upgrades leave stale cached output because the key only has the ETag.

**How to avoid:**
- Single-flight per key in process (promise map) plus a cross-replica refresh lease in Mongo; serve stale-while-revalidate (return cached immediately, refresh in the background); stale-if-error (keep serving last good for a bounded `maxStale`, expose `Warning`/health metric); jittered TTL; negative caching for 404 with a shorter TTL.
- Prefer a background refresher on a schedule over request-driven refresh, so request rate and Drive rate are independent. Revalidate with PROPFIND (properties only), GET only when the version token changed.
- Stability window: publish a new version only if `lastmodified` is older than `minAge` (e.g. 60-120 s) and unchanged across two polls. Ignore files matching `~$*`, `.~lock.*#`, `*.tmp`, `.DS_Store`, `Thumbs.db`, and a configurable draft prefix.
- On parse failure: keep last good, record the failure against the version token, back off, do not retry the same bad version every poll.
- Cache key = `mount + path + versionToken + converterVersion + options hash` (image mode, header row, sheet). Store rows chunked or one document per row batch if sizes can approach limits; cap size via PROPFIND `getcontentlength` before downloading.
- Warm cache sequentially at boot with the global request budget.
- The `ETag` you send to clients must derive from the cached representation (content hash + converter version), not Drive's ETag, otherwise a converter upgrade serves 304 for different content.
- `Cache-Control`: `public, max-age` only for anonymous-readable content; `private`/`no-store` and `Vary: Authorization` for anything behind apiKey or containing records; never let a shared cache store the collection list.

**Warning signs:**
Bursts of Drive requests exactly every TTL; a page flickers to an error after staff save; memory/Mongo growth from repeated large cache docs; 304 responses after a deploy that changed output.

**Phase to address:** P3 (all of it), with the request budget and single-flight primitive in P1.

---

### Pitfall 11: Treating `.xlsx` and `.docx` from Drive as trusted input

**What goes wrong:**
- **Zip bombs and parse DoS.** exceljs loads the entire workbook into a JS object graph (often 10-20x file size); a small file with a huge used range or highly compressible XML exhausts memory and blocks the event loop, failing `/health` and taking the hot path down. mammoth's README itself warns that crafted documents can cause high CPU/memory use `[HIGH]`.
- **mammoth CVEs.** Path traversal CVE-2025-11849 (fixed 1.11.0) and prototype pollution (fixed 1.12.2) `[MED]` (Snyk/NVD via search). Current npm version is 1.13.0 `[HIGH]`; pin `>=1.12.2` and run `npm audit` in CI.
- **External file access.** mammoth disables it by default; enabling `externalFileAccess` makes crafted `r:link` targets read local files `[HIGH]`. Never enable.
- **No sanitisation.** mammoth does not sanitise; output can contain `javascript:` links `[HIGH]`. Turndown passes the link through into Markdown, and the consuming website renders it, giving stored XSS in the website. Turndown's own advice is to sanitise untrusted HTML first, since a malicious string can affect the DOM parser before Turndown processes it `[MED]`.
- **Who is the attacker?** Staff are mostly trusted, but Drive folders can be shared, accounts can be phished, and the API is a publishing path. Defence in depth is cheap here.
- **Stale unpatched exceljs.** exceljs 4.4.0 was last modified 2024-12-20 `[HIGH]` (npm registry), with 670 open issues (GitHub page) and old pinned dependency ranges (`archiver ^5`, `unzipper ^0.10`, `uuid ^8`, `fast-csv ^4`) `[HIGH]`; `npm audit` noise and no upstream fixes are likely.

**How to avoid:**
- Gate before parse: size from PROPFIND `getcontentlength` (config max, e.g. 10 MB for xlsx, 20 MB docx); inspect the zip central directory with a lightweight reader (entry count, total uncompressed size, ratio cap e.g. 100:1 and 200 MB absolute) before handing bytes to exceljs/mammoth.
- Run conversions in a `worker_threads` pool (or child process) with `resourceLimits` and a wall-clock timeout; one conversion at a time per replica; the main thread keeps serving cached content. Never `await` conversion on the request path.
- Sanitise: run mammoth HTML through an allow-list sanitizer (e.g. `sanitize-html`/DOMPurify with jsdom) before Turndown; after Turndown, post-filter Markdown links/images to schemes `http`, `https`, `mailto`, `tel`, relative and `#`; drop raw HTML in the Markdown output.
- Wrap exceljs/mammoth behind internal `SpreadsheetReader`/`SpreadsheetWriter`/`DocConverter` interfaces so replacing exceljs (e.g. with a maintained fork or another library) is a one-file change. Do not leak exceljs types into route handlers.
- Test fixtures: zip bomb (synthetic, generated in test), docx with external-image relationship pointing at `file:///etc/hostname`, `javascript:` hyperlink, billion-laughs-style XML, xlsx with `A1048576` used range, deeply nested numbering.

**Warning signs:**
Event-loop lag alerts or `/health` timeouts after a content edit; RSS spikes; `javascript:` or `<script>` in cached Markdown; `npm audit` high findings with no fix.

**Phase to address:** P1 (interfaces, worker harness, size gates), P3 (conversion implementation + fixtures).

---

### Pitfall 12: Developing against a Mongo/FerretDB surface that diverges in dev, CI and prod

**What goes wrong:**
- A standalone `mongod` in Docker Compose has no replica set, so transactions and change streams are unavailable there but available in a production replica set (or vice versa with a managed offering). Code written against either works in one environment only `[HIGH]` (Mongo behaviour).
- FerretDB is a compatibility layer, not MongoDB. Third-party sources list gaps in change streams, `$lookup`, capped/time-series collections, retryable writes, GridFS, and disagree on transactions `[LOW]`; its own compatibility page lists known differences such as error message text and collection-name encoding `[LOW]` (fetch failed this session; re-check before claiming support).
- Using FerretDB in CI "to prove OSI-licensed stack" while production runs MongoDB means the two diverge silently.
- SSPL worry (`MongoDB Community is SSPL`) is largely irrelevant to a self-hosted internal service; letting it drive architecture early is a distraction. The EUPL-1.2 repo does not bundle MongoDB.
- Runtime index management: the config-defined "indexed fields" change over time; `createIndex` with a changed definition and the same name throws at startup; removed fields leave orphan indexes.
- IDs and timestamps: UUID stored as string vs BSON Binary vs ObjectId, `createdAt` as Date vs ISO string; hard to change later.

**How to avoid:**
- Define a **portable subset** and write it down: single-document CRUD, `findOneAndUpdate`, unique/compound/single-field indexes, simple `find` with sort/limit, no transactions, no change streams, no `$jsonSchema` validators, no TTL-index dependence for correctness, no `$lookup`.
- Leases, counters and dirty flags use single-document atomic operators only (Pitfall 5).
- CI matrix: run the same integration suite against real MongoDB and (as non-blocking job first) FerretDB; promote to blocking only if you intend to support it.
- Decide up front: `_id` = application-generated UUID string (portable, readable in the mirror); `createdAt`/`updatedAt` = BSON `Date`, serialised as ISO-8601 UTC at the API edge.
- Index reconciliation at boot: ensure-by-name with a config hash in the index name (`idx_<field>_<hash>`); report but do not automatically drop orphan indexes.

**Warning signs:**
"Works in compose, fails on the VPS"; use of `session.withTransaction` or `.watch()` anywhere in the diff; startup crash with `IndexOptionsConflict`.

**Phase to address:** P1 (portable-subset doc, test matrix), P2 (index reconciliation).

---

### Pitfall 13: Path traversal and mount escape

**What goes wrong:**
The Files endpoint and every sheet/document lookup take a user-supplied relative path. Escapes occur via `..`, `%2e%2e`, double-encoded `%252e`, `%2f` inside a segment, backslashes, NUL bytes, Unicode lookalikes and normalisation (`..` hidden in NFKC forms), or from the *server*: OX `Userstore` exposes other users' folders `[LOW]`, so a path that resolves above the mount root still lands on a valid Drive resource. A hostile or mistaken PROPFIND `href` (symlink-like shares, shared folders mounted elsewhere) can point outside the mount. Collection names from config are used as mirror file names without validation.

**How to avoid:**
- Segment-based `DrivePath`: split on `/` after a single decode, reject any segment that is `.`/`..`/empty/contains `\`, NUL, control chars, or `/`; compare final canonical segment array against the mount root *as arrays*; never string `startsWith` (`/mounts/a` vs `/mounts/ab`).
- Re-validate every `href` returned by PROPFIND against the mount before using or exposing it.
- Mount definitions validated at startup: no overlaps with write mounts, no write mount nested inside a read mount unless explicit, no mount at Drive root.
- Mirror and temp names generated from a strict allow-list regex.
- Unit tests with a traversal corpus (including double-encoding) run against `DrivePath` and the HTTP layer; property-based test: `resolve(mount, anything)` is always under the mount.
- Mode enforcement lives in the adapter wrapper, not in route handlers: a `read` mount's adapter has no write methods.

**Warning signs:**
Any code path calling `path.join` or `String.prototype.startsWith` on Drive paths; routes with a `*` wildcard param passed straight into the adapter.

**Phase to address:** P1.

---

## Moderate Pitfalls

### Pitfall 14: exceljs reading semantics (sheets as JSON rows)

**What goes wrong:**
- Cell shapes: formula cells are `{formula, result}`; `result` is absent if the file was never calculated by a spreadsheet app; rich text `{richText: [...]}`, hyperlinks `{text, hyperlink}`, errors `{error}`. Naive `JSON.stringify(cell.value)` leaks these objects to API consumers. `cell.text` vs `cell.value` vs `cell.result` differ.
- Dates: Excel stores serial numbers and no time zone; exceljs returns UTC-based `Date`. Date-only cells become `...T00:00:00.000Z` and shift a day in negative-offset clients. Whether a number is a date depends on its number format; the 1900 leap-year quirk and the 1904 date system exist `[MED]`. The streaming reader without styles enabled returns plain numbers for dates (needs `styles` option) `[MED]`.
- Header row: assumed to be row 1; blank, duplicate (`Name`, `Name`), whitespace/NBSP-padded, numeric or formula headers; title rows above the table; header names such as `__proto__`/`constructor` (prototype pollution or dropped keys when building row objects).
- Merged cells: only the master holds the value; exceljs makes non-master cells mirror it (duplicated values) and the streaming reader may give empty `Null` cells `[MED]`.
- Used range inflated by formatting to 1,048,576 rows; `eachRow({includeEmpty:true})` iterates all of them.
- **Hidden sheets, rows and columns and comments are still in the file.** Staff who hide a sensitive column believing it is not published will have it served by the API.
- Streaming reader (`WorkbookReader`) needs `sharedStrings`, `hyperlinks`, `styles` options enabled or strings/links/dates are missing `[MED]`.

**How to avoid:**
- Explicit `normalizeCell()` mapping every shape to a scalar; dates serialised as `YYYY-MM-DD` when time is 00:00 and the number format has no time part, otherwise ISO-8601 UTC with a documented `timezone` config; formula cells use `result`, null when absent (with a warning counter).
- Config per sheet: `sheet` (name, not index), `headerRow` (default 1), optional `range`, `maxRows`, `columns` allow-list. **Default to exposing only configured columns/sheets**; skip hidden sheets and hidden columns/rows by default (`state !== 'visible'`, `hidden`).
- Header normalisation: trim, collapse whitespace, reject/suffix duplicates deterministically (`Name`, `Name_2`), reject empty headers for configured columns, build row objects with `Object.create(null)` or `Map`.
- Merged-cell policy documented (default: value on master row only, others null) and fixture-tested.
- Row cap and stop-at-first-N-empty-rows heuristics; bounded `maxRows`.

**Warning signs:**
`[object Object]`, `{ "formula": ... }` in API output; dates off by one; missing last column; columns that staff believed hidden appear in responses.

**Phase to address:** P3 (fixtures built from files authored in Excel, LibreOffice and by exceljs itself).

---

### Pitfall 15: `.docx` → Markdown fidelity and policy gaps (mammoth + turndown)

**What goes wrong:**
- Images: mammoth inlines every image as a base64 `data:` URI by default `[HIGH]`; a photo-heavy doc becomes tens of MB of Markdown, passing the 16 MB BSON limit and bloating API responses. The "dropped or inlined" config must have a size cap with automatic fallback to drop.
- Tables: mammoth emits plain `<table>` without header cells; Turndown core does not do tables; `turndown-plugin-gfm` only converts tables with a header row and otherwise keeps raw HTML `[MED]`; colspan/rowspan, nested tables, multi-paragraph cells and `|` inside cells break pipe tables.
- Lists: "fake lists" typed by hand (`1.`, `-`, tabs) are not lists; numbering restarts and nested levels depend on `numbering.xml`.
- Styles: mammoth works best with real heading styles; custom or localised styles map to nothing without a style map `[HIGH]`; underline ignored, comments ignored, text boxes moved after their paragraph, empty paragraphs dropped `[HIGH]`. Equations and headers/footers likely dropped `[LOW]`. Tracked-change deletions and hidden text may or may not be included `[LOW]`: staff may believe deleted text is gone.
- Turndown escaping is aggressive (`snake\_case`, `1\.`) `[HIGH]`; non-breaking spaces, smart quotes and soft hyphens survive from Word.
- Drafts: Drive has no draft/publish state (see Pitfall 10).
- Download endpoint: files served from the API origin can be HTML/SVG executing as the API's origin; non-ASCII names break `Content-Disposition`.

**How to avoid:**
- Policy table in config and docs: images = `drop` (default) | `inline` with `maxInlineBytes`; tables = convert only if first row can be a header, else emit a synthetic header row or a fenced note; unsupported constructs logged as counters per document (never content).
- Provide a default `styleMap` and allow per-mount override; fixture docs authored in Word and LibreOffice, in a non-English UI, including tracked changes, hidden text, comments, footnotes, tables with merged cells.
- Normalise NBSP and zero-width characters; leave Turndown escaping on but document it, and expose raw `html` format as an option later.
- Downloads: `Content-Disposition: attachment; filename*=UTF-8''...`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, generic `application/octet-stream` unless the type is allow-listed; stream with back-pressure and abort the upstream request when the client disconnects.
- Include a "no draft" convention (prefix or subfolder ignored by the mount), documented for staff.

**Warning signs:**
Markdown containing `<table>` or `<img src="data:`; headings missing; articles published half-written.

**Phase to address:** P3.

---

### Pitfall 16: Retry policy that makes things worse

**What goes wrong:**
Blind retry-all with backoff. A revoked/expired app password (OX with 2FA requires an application password `[HIGH]`) yields 401 on every request; retrying logs in repeatedly and may lock the account. Retrying `MOVE`/`DELETE` after a timeout hits 404 and flips success to failure. PROPFIND retries multiply load under 503.

**How to avoid:**
Classify errors in the adapter: **no retry, open circuit, alert**: 401/403; **retry with jittered exponential backoff and `Retry-After`**: 429/502/503/504/ECONNRESET/timeouts on idempotent methods (GET, PROPFIND, PUT of the same bytes); **verify-then-decide**: MOVE/DELETE timeout (stat first); **no retry**: 4xx others. Circuit breaker with half-open probes. Readiness (`/ready`) reflects circuit state without calling Drive on every probe (cached result).

**Phase to address:** P1.

---

### Pitfall 17: PROPFIND/XML parsing assumptions

**What goes wrong:**
Namespace prefixes vary (`D:`, `d:`, default namespace) so prefix-based parsing breaks; `207` bodies contain per-property `404` propstats; `getetag` may be quoted or weak; `getlastmodified` has one-second resolution (edits within one second look unchanged); `allprop` returns bulky OX-specific properties; no pagination exists for very large folders; `Depth: infinity` is commonly rejected or expensive.

**How to avoid:**
Namespace-aware parser (e.g. `fast-xml-parser` with namespace removal, entity expansion limits on), request an explicit `<prop>` (`resourcetype getetag getlastmodified getcontentlength`), always `Depth: 0` or `1`, treat a 404 propstat as "absent", cap response size, parse dates with an RFC 1123 parser, and paginate/cache directory listings in the API layer. Fixtures from real OX responses (Pitfall 1).

**Phase to address:** P0/P1.

---

### Pitfall 18: Mirror columns and schema evolution

**What goes wrong:**
Columns are "derived from schema"; adding/renaming a schema field reorders or drops staff-visible columns; nested objects/arrays have no defined flattening; timestamps appear in UTC while staff are in another zone; schema changes make old records invalid so PUT of an old record fails.

**How to avoid:**
Explicit column list in config with a stable order (derived order only as a first-time default and then frozen); never remove a column without an explicit config change; flatten rules (arrays joined with `; `, objects as JSON string) fixed and documented; a `mirrorTimezone` setting for display times; record `schemaVersion` and decide validation behaviour for older records (validate on write only). Freeze header row, autofilter, column widths and number formats for staff usability.

**Phase to address:** P2.

---

### Pitfall 19: apiKey handling

**What goes wrong:**
Keys compared with `===` (timing leak); slow password hashes (bcrypt/argon2) on every request become a CPU DoS vector while plain unsalted fast hashes of *low-entropy* keys are brute-forceable; keys accepted in query strings and logged; keys not revocable without redeploy; key scope is per deployment, not per collection/operation.

**How to avoid:**
Generate 32+ random bytes, show once, store `SHA-256` (high-entropy input makes a fast hash acceptable) with a key id prefix for O(1) lookup, `crypto.timingSafeEqual` on the digest, header-only transport, per-key allowed collection/operations, `lastUsedAt` for rotation, and documented rotation procedure. Decide config-vs-Mongo storage in discuss-phase with this list as input.

**Phase to address:** P1.

---

## Minor Pitfalls

### Pitfall 20: Everyday operational traps

- **Fastify graceful shutdown:** in-flight mirror upload killed by SIGTERM; handle `close` hooks and release the lease.
- **Clock skew** between replicas breaks lease expiry; use Mongo server time (`$$NOW`) for lease timestamps.
- **`/ready` hitting Drive** on every probe amplifies load; cache result for 30 s.
- **OpenAPI at `/docs`** exposing schemas/internal paths on a public host; allow disabling and don't ship examples with realistic personal data (synthetic only).
- **Synthetic-data policy:** fixtures generated by scripts, not copied from the real adopter; add a CI grep for the adopter's organisation name and for real-looking emails.
- **Docker image:** run as non-root, read-only filesystem, no `latest` tags, pin Node LTS.
- **Free-text spreadsheet header detection by index** breaks when staff insert a column; use header names.
- **Locale decimal separators** in sheets typed as text (`"3,5"`): keep as strings unless the cell is numeric.
- **License attribution:** EUPL-1.2 repo with MIT/Apache deps: keep a third-party notices file; "mailbox.org" used descriptively only, README says unofficial.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Skip the spike, code to RFC 4918 | Starts faster | Rewrite of adapter, mirror and cache once OX behaves differently | Never |
| In-memory debounce only for mirror | No lease code | Stale overwrite, lost dirty state on crash | Only with enforced one-replica + persisted dirty flag |
| Regenerate mirror per write | Simple | Version/quota/rate-limit blowup | Never |
| exceljs types leaked into services | Less glue | Library lock-in with an unmaintained library | Never |
| Fastify default Ajv for collection schemas | Zero config | Silent coercion and key stripping | Never |
| One cache doc per workbook | Simple | 16 MB limit, big reads | Small sheets with a hard size gate |
| Retry everything | Short code | Account lockout, duplicate work | Never |
| No `If-Match` on records | Simpler PATCH | Lost updates | Acceptable at tens of writes/week if documented, but cheap to add |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| OX WebDAV auth | Main password with 2FA enabled | Dedicated service mailbox, application password, only the needed folder shared to it `[HIGH]` |
| OX WebDAV base URL | Calling `https://dav.mailbox.org/` or a bare folder | Base is `/servlet/webdav.infostore/`; personal folders live under `Userstore/` `[HIGH]` |
| OX WebDAV client | Chunked PUT, HTTP/2, large pools | Content-Length, HTTP/1.1, pool of 2-4 `[LOW]` |
| MongoDB | Transactions/change streams | Single-document atomic ops only |
| Kong | Default log plugins capture bodies/queries | Reference config logs method, route, status only |
| Fastify behind proxy | `trustProxy: true` | Exact hop/CIDR, tested with forged XFF |
| exceljs | `cell.value` passed through | Normaliser per cell type |
| mammoth | Default image handler and no sanitising | `convertImage` policy + sanitizer |
| turndown | Feeding raw mammoth HTML, no GFM plugin | Sanitise first; GFM plugin with table policy |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Parsing xlsx/docx on the request thread | Event-loop stalls, `/health` fails | Worker pool + timeout + cache | First 5-20 MB file |
| Request-driven Drive revalidation | Burst at every TTL | Background refresh, single-flight, SWR | Tens of concurrent visitors |
| `skip` pagination | Slow lists | Cursor on `(createdAt,_id)` | ~10k+ records after spam |
| Full-workbook in-memory write | Memory spike on regen | Row cap, streaming writer above cap | ~100k rows (spam) |
| Large directory PROPFIND | Slow, big XML | Cache + paginate in API | Thousands of files |
| Proxying large downloads through Node | Memory/socket exhaustion | Stream with back-pressure, abort on disconnect, size cap | Concurrent big files |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Wildcard CORS on write routes | Cross-site submission abuse | Per-collection origin allow-list |
| Returning created record including server fields to anonymous | Data exposure | Anonymous create returns only `id`/`createdAt` |
| Anonymous GET of collections by mistake | Mass personal-data leak | Policy default-deny; per-operation explicit; startup warning if `list`/`get` is anonymous |
| Serving staff files inline | Stored XSS on API origin | `attachment` + `nosniff` + sandbox CSP |
| Exposing hidden sheets/columns | Data staff believed hidden is public | Allow-list columns, skip hidden |
| Secrets in config dumps/repo | Credential leak | Env only, redacted logging, secret scanning in CI |
| Raw HTML/`javascript:` in Markdown | XSS in the website | Sanitise + scheme allow-list |
| `/docs` and error bodies leak internals | Recon | Generic error bodies with request id |

## "Looks Done But Isn't" Checklist

- [ ] **WebDAV adapter:** works with `Last, First` names against real OX, not only Docker WebDAV
- [ ] **Mirror:** two app instances running at once never produce an older snapshot
- [ ] **Mirror:** unchanged data produces no upload (row-hash skip), verified by version count on Drive
- [ ] **Mirror:** record containing `=1+1`, `\u0000`, 40k chars, and `{ "formula": "1+1" }` opens cleanly in Excel and LibreOffice
- [ ] **Anonymous POST:** forged `X-Forwarded-For` through the reference gateway does not bypass the limit
- [ ] **Logs:** canary PII string absent from all logs on success and every error path
- [ ] **Cache:** killing Drive access keeps serving last-good content; bad file does not replace good cache
- [ ] **Cache:** cold start with 50 concurrent requests causes at most one Drive fetch per key
- [ ] **Sheets:** hidden column/sheet not exposed; duplicate/blank headers handled; dates not off by one
- [ ] **Docs:** `javascript:` link, `file://` image, base64 image over limit, header-less table all handled
- [ ] **Traversal corpus** passes at unit and HTTP level
- [ ] **Retry:** 401 from Drive does not loop
- [ ] **Mongo:** suite passes on a replica-set-less standalone mongod and (if claimed) FerretDB

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Corrupt/stale mirror | LOW | Mongo is system of record; bump `dirtySeq`, regenerate whole workbook |
| Mirror versions flood quota | MEDIUM | Stop mirror loop, purge versions via OX UI/support, restore with hash-skip |
| Spam wave in collection | MEDIUM | Soft-flag by criteria, bulk delete, tighten limits, enable challenge hook |
| Mailbox.org suspends access | HIGH | StorageAdapter swap; MongoDB holds all records; mirror to another WebDAV/S3 target |
| PII found in logs | HIGH | Purge log store, rotate, fix serializer, add canary test regression |
| Poisoned cache entry | LOW | Delete by key / bump `converterVersion` |
| Account lockout from 401 loop | MEDIUM | New app password, circuit breaker reset, contact support |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1 WebDAV semantics unverified | P0, P1 | Compatibility matrix + real-OX contract run |
| 2 Non-atomic temp+MOVE | P0, P2 | Spike result recorded; orphan cleanup test |
| 3 Version/quota/rate amplification | P0, P2 | Hash-skip test; Drive version count |
| 4 Path/href encoding | P0, P1 | Fixture corpus with commas/spaces/NFD |
| 5 Fake single-writer | P2 | Two-instance integration test |
| 6 Hostile values in xlsx | P2 | Fixture opens in LibreOffice headless |
| 7 Anonymous abuse | P1, P2 | Forged XFF test, ceiling test |
| 8 Ajv/query/PATCH traps | P1, P2 | Coercion and injection tests |
| 9 PII in logs | P1, P2 | Canary-in-logs CI test |
| 10 Cache stampede/draft publish | P1 (primitives), P3 | Concurrency test, stale-if-error test |
| 11 Untrusted office files | P1, P3 | Bomb/XXE/external-link fixtures |
| 12 Mongo/FerretDB divergence | P1, P2 | CI matrix, portable-subset doc |
| 13 Traversal / mount escape | P1 | Traversal corpus + property test |
| 14 exceljs read semantics | P3 | Excel/LibreOffice-authored fixtures |
| 15 mammoth/turndown fidelity | P3 | Fixture docs, sanitizer tests |
| 16 Retry policy | P1 | 401/429/503 simulations |
| 17 PROPFIND parsing | P0, P1 | Real-OX XML fixtures |
| 18 Mirror schema evolution | P2 | Schema change test |
| 19 apiKey handling | P1 | Timing-safe compare test, scope tests |

## Phase-Specific Research Flags

| Phase | Needs deeper research? | Why |
|-------|------------------------|-----|
| P0 WebDAV/OX spike | **Yes, it is the research** | Everything OX-specific is LOW confidence. Spike checklist is in Pitfall 1 + 2 + 3 + 4 + 17; also ask mailbox.org support for limits and Drive plan quota; confirm Art. 28 DPA covers Drive |
| P1 Foundation | Light | Mostly standard patterns; research worker-thread conversion harness, Ajv 2020-12 setup |
| P2 Collections + mirror | Medium | Lease/fencing design, exceljs deterministic output, hash-skip |
| P3 Read-only content | Medium | Fixture corpus is the work; sanitiser choice; exceljs replacement fallback |

## Sources

- mailbox.org knowledge base, WebDAV for Linux (search result, davfs2 `if_match_bug 1`, `use_locks 0`, base URL `/servlet/webdav.infostore/`, `Userstore`, app passwords with 2FA): https://kb.mailbox.org/en/private/drive-article/webdav-for-linux `[HIGH]` (page itself could not be fetched; content from search snippet, treat as MED-HIGH)
- mailbox.org WebDAV for Windows/macOS: https://kb.mailbox.org/en/private/drive-article/webdav-for-windows
- User reports of 401 over HTTP/2 with rclone: https://userforum-en.mailbox.org/topic/4966/vote/add/1 `[LOW]`
- Cryptomator community thread on mailbox.org WebDAV conditional requests: https://community.cryptomator.org/t/have-to-clear-the-cache-at-every-start-of-the-app-to-get-access-to-webdav-vault/7263/2 `[LOW]`
- RFC 4918 (WebDAV; MOVE/COPY/Overwrite, locking optional): https://www.rfc-editor.org/rfc/rfc4918 `[HIGH]`
- mammoth.js README (no sanitisation, `externalFileAccess`, DoS warning, base64 images, ignored features): https://github.com/mwilliamson/mammoth.js/blob/master/README.md `[HIGH]`
- mammoth path traversal CVE-2025-11849 (fixed 1.11.0): https://security.snyk.io/vuln/SNYK-JS-MAMMOTH-13554470 ; https://nvd.nist.gov/vuln/detail/CVE-2025-11849 `[MED]`
- mammoth prototype pollution (fixed 1.12.2): https://security.snyk.io/vuln/SNYK-JS-MAMMOTH-20074633 `[MED]`
- Turndown (GFM plugin, aggressive escaping): https://github.com/mixmark-io/turndown ; untrusted-input warning relayed via search `[MED]`
- exceljs repository and README (value types, merged cells, streaming limits; 670 open issues): https://github.com/exceljs/exceljs `[MED]`
- npm registry queried 2026-11-21: exceljs 4.4.0 modified 2024-12-20 with dependencies `archiver ^5`, `unzipper ^0.10.11`, `uuid ^8`, `fast-csv ^4`; mammoth 1.13.0; turndown 7.2.5; @fastify/rate-limit 11.3.0 `[HIGH]`
- exceljs memory and merged-cell issue threads: https://www.github.com/exceljs/exceljs/discussions/2401 ; https://www.github.com/exceljs/exceljs/discussions/2758 `[LOW-MED]`
- @fastify/rate-limit README (in-memory store per process, `trustProxy`, `keyGenerator`): https://raw.githubusercontent.com/fastify/fastify-rate-limit/main/README.md ; trustProxy spoofing write-up: https://safeguard.sh/resources/blog/fastify-trustproxy-and-rate-limit-keys `[MED]`
- FerretDB compatibility (official page fetch failed; third-party): https://docs.ferretdb.io/migration/compatibility/ ; https://oneuptime.com/blog/post/2026-03-31-mongodb-mongodb-vs-ferretdb-protocol-alternatives/view `[LOW]`
- Project context: `/Users/serhiy/orca/workspaces/mailbox-org-drive-rest-api/snook/.planning/PROJECT.md`
- Training-knowledge items (Fastify Ajv defaults, Mongo E11000 message content, BSON 16 MB limit, Excel limits, WHATWG URL base resolution, Mongo replica-set requirement for transactions/change streams) `[MED]`: verify against current docs while implementing.

---
*Pitfalls research for: REST API over mailbox.org Drive (OX WebDAV) with MongoDB and xlsx/docx conversion*
*Researched: 2026-11-21*
