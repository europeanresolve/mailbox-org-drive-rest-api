# Technology Stack

**Project:** mailbox-org-drive-rest-api
**Researched:** 2026-11-21
**Mode:** Ecosystem (greenfield, stack dimension)
**Overall confidence:** HIGH on versions (read from the npm registry and Docker Hub on the research date), MEDIUM on a few opinionated slots (flagged per row).

Locked in PROJECT.md and not re-litigated: TypeScript on Node LTS, Fastify, MongoDB, exceljs, mammoth + turndown, pino, Docker Compose, Kong reference config. For those the job here was to verify versions and surface gotchas.

## Headline Findings (read these first)

1. **TypeScript 7.0 (native compiler) is now `latest`, and `typescript-eslint` does not support it.** typescript-eslint 8.73 declares `typescript >=4.8.4 <6.1.0`, and the native compiler has no JS API for its type-aware rules. This decides lint tooling: use **Biome**, not ESLint + typescript-eslint (HIGH).
2. **Node 26 is Active LTS (since 2026-10-28); Node 24 is already Maintenance (since 2026-10-20).** Target Node 26, keep Node 24 in the CI matrix (HIGH, official release schedule).
3. **Neither dev WebDAV server candidate I tested enforces `If-Match` on PUT.** hacdias/webdav and `rclone serve webdav` (both Go `x/net/webdav`) returned 201 for a bogus `If-Match`. Apache httpd mod_dav returned 412, but its ETags are weak (`W/"..."`), so even a correct `If-Match` gets 412. Never rely on conditional writes for correctness. The single-writer mirror design already avoids them (HIGH, tested locally 2026-11-21).
4. **The `webdav` npm package strips every `"` from ETags.** A weak ETag `W/"abc"` comes back as `W/abc`. Normalise in the adapter and treat the ETag as an opaque cache key only (HIGH, read in `dist/node/tools/dav.js`).
5. **exceljs 4.4.0 has had no release since 2023-10-19.** It is locked, so keep it, pin it exactly, and confine it behind one internal module so it can be swapped (HIGH on the fact, MEDIUM on the risk).
6. **Fastify's built-in Ajv is configured for request coercion** (`coerceTypes: 'array'`, `useDefaults: true`, `removeAdditional: true`). Do not use it to validate stored collection records. Use a dedicated strict Ajv instance (HIGH, Fastify docs).

## Recommended Stack

### Runtime and Language

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| Node.js | 26.x (Active LTS); CI also runs 24.x | Runtime | 26 became LTS on 2026-10-28 and is supported to 2029-04-30. 24 is in Maintenance to 2028-04-30, so it is a valid floor. `engines: ">=24"`. | HIGH |
| TypeScript | 7.0.2 (native `tsc`) | Typecheck and emit | Current `latest`. Much faster typecheck. Only constraint is tooling that imports the compiler as a library (typescript-eslint, ts-morph), which this stack avoids. Use `tsc --noEmit` in CI and `tsc` to emit `dist/`. | MEDIUM: 7.0 is only about 4 months old, so check `rewriteRelativeImportExtensions` and `erasableSyntaxOnly` work in a first spike |
| ESM (`"type": "module"`) | n/a | Module format | `webdav` 5, `p-retry` and `p-limit` are ESM-only, and Fastify 5 and mongodb 7 work fine under ESM. Avoids CJS/ESM interop bugs. | HIGH |
| Native type stripping | Node 24+ / 26 | Dev runner | `node --watch src/server.ts` runs TS without `tsx`. Requires `erasableSyntaxOnly: true` (no enums or parameter properties) and `.ts` extensions in relative imports. Production still runs compiled `dist/`. | MEDIUM |

### Core Framework

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| fastify | 5.12.8 | HTTP framework | Locked. JSON Schema validation, encapsulation, `inject()` for tests, pino built in. | HIGH |
| fastify-plugin | 6.0.1 | Break encapsulation for shared decorators | Needed for the storage, db and auth plugins. | HIGH |
| @fastify/swagger | 9.9.5 | OpenAPI generation | `openapi: { openapi: '3.1.0' }` is supported. 9.x targets Fastify 5. | HIGH |
| @fastify/swagger-ui | 6.1.5 | `/docs` UI | Official, same release train. Scalar (`@scalar/fastify-api-reference` 1.82.1) is a cosmetic alternative. Skip it. | HIGH |
| typebox | 1.4.7 | Static schemas (config, route params, error envelopes) | See "TypeBox: yes, scoped" below. Package name is `typebox`, not the legacy `@sinclair/typebox` (0.34.x). | HIGH |
| @fastify/type-provider-typebox | 6.3.0 | Infer handler types from route schemas | Peer is `typebox ^1.1.14`, so it matches. | HIGH |
| @fastify/cors | 11.4.3 | Browser form posts | The first use case is website forms posted from browsers. Allow-list origins per deployment. | HIGH |
| @fastify/rate-limit | 11.3.0 | In-app rate-limit fallback | Locked as fallback to Kong. In-memory store is correct for a single instance. Set `trustProxy` correctly behind Kong, or every client shares the proxy's IP bucket. | HIGH |
| @fastify/helmet | 13.2.0 | Security headers | Cheap. Relax CSP on `/docs` only (swagger-ui needs inline assets). | HIGH |

### Validation of collection records (the open JSON Schema question)

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| ajv | 8.20.0 | Validates records against each collection's JSON Schema | A separate instance from Fastify's. Use `ajv/dist/2020` (draft 2020-12). Options: `strict: true`, `allErrors: false`, no `coerceTypes`, `removeAdditional: false`, `useDefaults: false`, no `loadSchema` (no remote `$ref`). The server owns `id`, `createdAt` and `updatedAt`, so the client must not set them. | HIGH |
| ajv-formats | 3.0.1 | `email`, `date-time`, `uri` formats | Anonymous forms always need `email`. | HIGH |

Wire it in by registering each collection's routes in an encapsulated plugin with `setValidatorCompiler(({ schema }) => ajv.compile(schema))`. Fastify then validates and `@fastify/swagger` documents each collection's body schema automatically.

### Database

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| MongoDB server | `mongo:8.0` (pin the minor in Compose) | System of record | 8.0 is the stable line. 8.3 tags exist on Docker Hub but are rapid releases, so avoid them for a long-lived self-hosted deployment. A standalone node is enough (no multi-document transactions needed). | MEDIUM |
| mongodb (official driver) | 7.9.1 | Data access | Needs Node >=20.19. Ships its own types. Collections are user-defined JSON Schemas, so a static-model ODM adds nothing. | HIGH |

**Not Mongoose (9.12.3):** its value is static schemas and model classes. Here the schema is runtime data validated by Ajv, so Mongoose would sit unused on top of the driver.
**Not `@fastify/mongodb` (10.0.2):** a thin decorator over the driver. About 10 lines of your own plugin gives you explicit lifecycle and graceful shutdown. Skip the dependency.

Design notes for the db layer, with no library needed:
- Store `_id` as a string UUID from `crypto.randomUUID()`. This drops the `uuid` package (14.0.3).
- Paginate by keyset on `(createdAt, _id)`, not `skip`.
- Create the single-writer mirror lease with `findOneAndUpdate` on a lease document plus a TTL index.

### Storage (WebDAV) and file formats

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| webdav | 5.11.0 | WebDAV client inside `WebDavStorageAdapter` | See "WebDAV client decision". ESM-only, bundles types, active (published 2026-09). | MEDIUM |
| p-retry | 9.0.0 | Exponential backoff on 429/503/network errors | `webdav` has no retry. Wrap each adapter call, honour `Retry-After`. | MEDIUM |
| p-limit | 7.3.3 | Cap concurrent Drive requests (suggest 2-4) | PROJECT.md requires low concurrency. | MEDIUM |
| exceljs | 4.4.0 (pin exact, no caret) | `.xlsx` mirror write and sheet read | Locked. See "exceljs risk" below. | HIGH on version, MEDIUM on suitability |
| mammoth | 1.13.0 | `.docx` to HTML | Locked. Bundles types. Published 2026-09. | HIGH |
| turndown | 7.2.5 | HTML to Markdown | Locked. Active (2026-11). Pulls `@mixmark-io/domino` for Node DOM. | HIGH |
| turndown-plugin-gfm | 1.0.2 | Tables and strikethrough | Needed because Word tables become `<table>`. Unmaintained since 2019 but stable. Needs a local `declare module` (no types). `@types/turndown` is 5.0.6. | MEDIUM |

### Config, logging, keys

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| yaml | 2.9.1 | Parse config file | Humans edit collection definitions, so YAML with comments beats JSON. | HIGH |
| (none) TypeBox + Ajv | n/a | Validate config, fail fast | Already in the tree, so no zod, convict or envalid. Env vars override or supply secrets. Support a `*_FILE` convention for Docker secrets. Use `node --env-file` for local `.env`. No `dotenv`. | MEDIUM |
| pino | 10.4.0 | Logs (Fastify's built-in logger) | Locked. Configure `redact` for `authorization` and `x-api-key`. Log `request.routeOptions.url`, not the raw URL, because list filters can carry personal data in the query string. | HIGH |
| pino-pretty | 13.2.0 (dev only) | Readable dev logs | Never in the production image. | HIGH |
| `node:crypto` | built in | API-key hashing | See "API key hashing". | HIGH |

### Dev, test, quality

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| pnpm | 12.21.0 | Package manager | Closes the open question. Supply-chain protections in current docs: dependency build scripts are blocked unless allow-listed, exotic transitive sources are blocked, and a minimum release age applies. Strict `node_modules` catches phantom deps. Commit `packageManager` and the lockfile. | MEDIUM |
| vitest | 5.1.1 | Unit and integration tests | Engines `^22.12 \|\| ^24 \|\| >=26`. Runs TS natively, has watch mode, coverage via `@vitest/coverage-v8` 5.1.1. Beats `node:test` on mocking, snapshots and `globalSetup`. | HIGH |
| @types/node | 26.x (match the Node major) | Types | `@types/node` is at 26.6.6. | HIGH |
| @biomejs/biome | 2.6.8 | Lint and format, one tool | Not blocked by TS 7 (own parser). Replaces ESLint + typescript-eslint + Prettier. Enable nursery `noFloatingPromises` as an error. It is experimental, but unawaited promises are the main async-API bug class. | MEDIUM |
| Docker Compose | v2 | Local stack | Locked. `mongo:8.0` + WebDAV server. | HIGH |
| hacdias/webdav | `v5` (v5.17.3, pushed 2026-10-30) | Local WebDAV server for dev and integration tests | See below. | HIGH on behaviour, tested |

### Container

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `node:26-slim` | pin by digest at release | Final image | Debian glibc, official, tag exists (updated 2026-11-11). No native deps in the dependency set, so Alpine's musl would work, but slim is easier to debug and has fewer surprises. Multi-stage: build with full pnpm, copy `dist/` plus production `node_modules`, run as the `node` user. Healthcheck with `node -e "fetch(...)"` (slim has no curl). | MEDIUM |
| Distroless Node | optional hardening | Smaller attack surface | Check that a Node 26 variant exists before adopting. I did not verify it. | LOW |

## Decisions on the Open Slots

### WebDAV client: use `webdav` 5.11.0 behind `StorageAdapter`

Alternative: hand-roll on `undici` + `fast-xml-parser`. It needs six verbs (PROPFIND, GET, PUT, MKCOL, MOVE, DELETE) and gives full control over ETags, retries and path encoding.

I recommend `webdav` because it costs less code, it is maintained, and the `StorageAdapter` interface makes a later swap cheap. It brings these gotchas, which belong in the adapter's contract tests:

- **ETag mangling.** It runs `etag.replace(/"/g, "")`. Store whatever it returns as an opaque token and never send it back in `If-Match`.
- **No retry, no timeout policy.** Add `p-retry` and an `AbortSignal` timeout yourself.
- **HTTP client is `node-fetch` 3.** Customisation is through `httpAgent` / `httpsAgent` and the global `getPatcher()`, which is process-wide, not per client. Do not patch it for one adapter instance.
- **Path encoding** of folders such as `Userstore/Last, First` is undocumented in the README. Cover it with a contract test in the early OX spike, because OX behaviour is unknown anyway.
- **Atomic mirror write.** `putFileContents(tmp)` then `moveFile(tmp, final)`. `moveFile` sends `Overwrite: T` by default. Use `customRequest` for anything fancier.
- **Audit noise.** `pnpm audit` flags `minimatch` in `webdav`. It is only used by the `glob` option on directory listings. Do not use that option, and treat it as an accepted finding.

### Mongo test strategy: Compose, not Testcontainers

Integration tests need two services (Mongo and WebDAV), and the dev stack already defines them. Use `docker compose up -d --wait` locally and in CI. A vitest `globalSetup` pings both and fails fast with a clear message. Each run uses a unique database name and a unique WebDAV subfolder, so parallel runs and reruns cannot collide.

Why not `testcontainers` 12.2.2 / `@testcontainers/mongodb`: it duplicates the service definitions, needs the Docker socket from inside CI, and would still need a custom WebDAV container. Why not `mongodb-memory-server` 11.3.0: it downloads a mongod binary and is not the real server image. Revisit Testcontainers only if "run `pnpm test` with nothing preinstalled" becomes a goal.

Unit tests need neither service. Keep the `StorageAdapter` and collection repository behind interfaces and fake them.

### Local WebDAV server: `hacdias/webdav` v5

Tested on 2026-11-21 against three servers using a throwaway script:

| Behaviour | hacdias/webdav v5 | rclone serve webdav | Apache httpd 2.4 mod_dav |
|-----------|-------------------|---------------------|--------------------------|
| PUT returns ETag | yes (strong, mtime+size hex) | yes (same scheme) | no |
| PROPFIND `getetag` | strong | strong | weak `W/"..."` |
| `If-Match` bogus value on PUT | 201 (ignored) | 201 (ignored) | 412 |
| `If-Match` with the correct value | 201 | 201 | 412 (weak ETag fails strong compare) |
| MOVE with `Overwrite: T` | 204 | 204 | 204 |
| MKCOL / PROPFIND on `Last, First` folder | OK | OK | OK |
| `If-None-Match` GET | 304 | 304 | 304 |
| Image size / upkeep | about 4 MB, tags updated 2026-10 | large Go image | stock `httpd`, needs a config file |

Choice: `hacdias/webdav:v5`. It is tiny, takes a short YAML config (directory, user, password) and passes all the verbs the adapter needs. Because both Go-based servers ignore `If-Match`, the integration suite can never prove conditional-write behaviour. That is a reason to keep the design free of it. Optionally add Apache httpd as a second, "strict" Compose profile to catch accidental `If-Match` use.

I did not evaluate `bytemark/webdav` (its Docker Hub page shows about 7 years without an update), nginx `dav` (needs the third-party `dav-ext` module for PROPFIND) or sabre/dav (PHP, heavier).

### TypeBox: yes, scoped

Use TypeBox for static things: config schema, route params/query, error envelope, and response schemas. It gives the OpenAPI schema and the TS type from one definition, and `@fastify/type-provider-typebox` gives typed handlers. Do not use it for collection record schemas. Those are runtime JSON Schemas from config and go through the strict Ajv instance. Rejected: `fastify-type-provider-zod` 7.0.0 and `zod` 4.6.7, which would add a second schema system next to the JSON Schema the product already exposes.

### exceljs risk (locked, so mitigate)

- Last release 4.4.0 on 2023-10-19. Forks exist (`@protobi/exceljs`, `@mui/x-internal-exceljs-fork`) but they are special-purpose. Do not adopt them now.
- `pnpm audit` flags `uuid` (exceljs depends on `^8.3.0`). exceljs only calls `v4()` without a buffer, and the advisory concerns v3/v5/v6 with a `buf` argument, so it is unreachable. Record it as an accepted finding. Do not force an override to uuid 14.
- Mitigations: wrap exceljs in one `workbook/` module (`writeMirror(rows, columns)`, `readSheet(buffer)`); `stat` the file before downloading and refuse files above a configured size, because exceljs loads whole workbooks in memory; cap rows per mirror.
- Exit path if it breaks: `read-excel-file` 9.3.20 (active, published 2026-11-19) for reads, and `write-excel-file` 4.1.1 for the simple header-plus-rows mirror. Avoid the npm `xlsx` package (0.18.5 is the abandoned SheetJS release with known advisories).

### API key hashing: SHA-256 via `node:crypto`

Keys are 32 random bytes (about 256 bits of entropy). Format: `<keyId>.<secret>`, with `keyId` public and the secret base64url. Store `keyId` and `sha256(secret)` (optionally HMAC-SHA256 with a server-side pepper from env). Look up by `keyId`, compare with `crypto.timingSafeEqual`. Show the plaintext once at creation.

Why not argon2 (`argon2` 0.45.2, `@node-rs/argon2` 2.2.2) or bcrypt: slow hashes protect low-entropy human passwords. For high-entropy random tokens they add nothing, bring a native build, and put 50-100 ms of CPU on every request. That is a self-inflicted DoS vector on exactly the hardened anonymous-adjacent endpoints. This works the same whether keys live in config (hash only) or in MongoDB (rotation endpoints), which settles the hashing half of that open question. (HIGH.)

### Lint and format: Biome, not ESLint

- ESLint 10.15.0 + typescript-eslint 8.73.0 requires a TypeScript below 6.1 for type-aware rules, so you would run two TypeScript installs (the workaround people use) or stay on TS 6. Not worth it.
- Biome 2.6.8 handles lint and format in one fast binary, and typecheck stays with `tsc`.
- Gap: type-aware rules are thin in Biome, and `noFloatingPromises` is nursery. If that proves insufficient, the planned upgrade is oxlint with `tsgolint`, which reached a stable v7 and tracks TS 7.0.2 (covers 59 of 61 typescript-eslint type-aware rules; check the exact rule list first). Prettier 3.10.1 is not needed.

### Not needed (ponytail list)

| Skipped | Why |
|---------|-----|
| `tsx` 4.23.15 | Node strips types natively. Add only if the native path fails in the spike. |
| `tsup` / `tsdown` | No bundling needed for a server image. `tsc` to `dist/` is enough. |
| `supertest` 7.3.2 | `fastify.inject()` (light-my-request) is built in. |
| `uuid` 14.0.3 | `crypto.randomUUID()`. |
| `@fastify/etag` 6.2.2 | It hashes payloads. We already have an upstream ETag or `updatedAt`, so a 10-line conditional-GET helper is more exact. Revisit only for collection list responses. |
| `@fastify/under-pressure` 9.2.2 | `/ready` is a Mongo ping plus a WebDAV `stat`. Load shedding is the gateway's job. |
| `@fastify/sensible` 6.0.8 | Optional. Own error envelope is simple enough. |
| `dotenv`, `convict`, `envalid`, `zod`, `c12` | Config is YAML + TypeBox + Ajv + `--env-file`. |
| Mongoose, `@fastify/mongodb` | See Database. |
| Redis / BullMQ | The mirror is a debounced single writer. A Mongo lease is enough at tens of writes per week. |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| WebDAV client | `webdav` 5.11.0 | Hand-rolled `undici` + `fast-xml-parser` | More code now. Reconsider if the OX spike finds path-encoding or ETag problems the library hides. |
| Mongo access | `mongodb` 7.9.1 | Mongoose 9.12.3 | Schemas are runtime data, so no model layer is needed. |
| Test runner | vitest 5.1.1 | `node:test` | No built-in mocking ergonomics, coverage or `globalSetup` equivalent that matches. Native TS in vitest. |
| Integration infra | Compose stack | Testcontainers 12.2.2 | Duplicates service defs and needs Docker socket in CI. |
| Lint/format | Biome 2.6.8 | ESLint 10 + typescript-eslint + Prettier | typescript-eslint peer range excludes TS 7. |
| Package manager | pnpm 12.21.0 | npm 11.12.1 | npm is installed already, but pnpm gives stricter dependency resolution and supply-chain defaults. Cost: one extra tool in CI and Docker. |
| Schema typing | TypeBox 1.4.7 | zod 4.6.7 | Second schema language. Product already speaks JSON Schema. |
| Key hashing | SHA-256 / HMAC | argon2, bcrypt | Wrong tool for high-entropy tokens. Native build and request-time CPU. |
| Dev WebDAV | hacdias/webdav v5 | rclone, Apache mod_dav, bytemark | See the behaviour table. |
| Container base | `node:26-slim` | Alpine, distroless | Slim is the lowest-friction default. Distroless is an optional later hardening step. |

## Installation

```bash
# Runtime
pnpm add fastify@5.12.8 fastify-plugin @fastify/swagger @fastify/swagger-ui \
  @fastify/cors @fastify/rate-limit @fastify/helmet \
  typebox @fastify/type-provider-typebox ajv ajv-formats \
  mongodb webdav p-retry p-limit yaml \
  exceljs@4.4.0 mammoth turndown turndown-plugin-gfm

# Dev
pnpm add -D typescript @types/node @types/turndown \
  vitest @vitest/coverage-v8 @biomejs/biome pino-pretty
```

pnpm blocks dependency build scripts by default. None of these packages should need one, so do not allow-list anything. Fix the cause if the install asks you to. `pino` arrives with Fastify. Pin the same major as Fastify expects and do not add it separately unless you use it outside Fastify.

Dev stack sketch (`compose.yaml`): `mongo:8.0` with a healthcheck, and `hacdias/webdav:v5` with a mounted YAML config (`directory: /data`, one dev user). Both on `docker compose up -d --wait`.

## Open Risks for the Roadmap

- **TS 7 + `erasableSyntaxOnly` + native type stripping** is the newest piece (MEDIUM). Budget a half-day spike in phase 1 and keep `tsx` as the fallback.
- **OX WebDAV differences** from the dev server (ETag shape, locking, versioning, trash, path encoding) cannot be tested locally. The early spike must record real behaviour and turn it into adapter contract tests. Run the same contract suite against hacdias and, optionally, Apache.
- **Fastify 5.12 + typebox 1.x** are both recent. Pin exact versions in the lockfile and upgrade deliberately.
- **Biome `noFloatingPromises`** is experimental. Treat lint as a supplement to review, not a guarantee.

## Sources

- npm registry (`npm view`), 2026-11-21: versions and publish dates for every package above, plus peer dependency ranges (`typescript-eslint` peer `typescript <6.1.0`; `@fastify/type-provider-typebox` peer `typebox ^1.1.14`; `vitest` engines) and `exceljs` release time (`4.4.0`, 2023-10-19). HIGH.
- Node.js release schedule, https://raw.githubusercontent.com/nodejs/Release/main/schedule.json: v24 maintenance 2026-10-20, v26 LTS 2026-10-28. HIGH.
- Node.js previous releases, https://nodejs.org/en/about/previous-releases. HIGH.
- Fastify validation reference, https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/: default Ajv options, `setValidatorCompiler`. HIGH.
- @fastify/swagger README, https://github.com/fastify/fastify-swagger: OpenAPI 3.1 option, Fastify 5 compatibility table. HIGH.
- Biome rule page, https://biomejs.dev/linter/rules/no-floating-promises/: nursery status. HIGH.
- pnpm supply-chain page, https://pnpm.io/supply-chain-security: build blocking, exotic subdeps, release age. MEDIUM (pnpm 12 defaults not stated on the page).
- typescript-eslint and TS 7 status: https://github.com/typescript-eslint/typescript-eslint/issues/12518, https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/. MEDIUM (search summary, but consistent with the registry peer range).
- tsgolint / oxlint status, https://infoq.com/news/2026/09/tsgolint-oxlint-typescript. MEDIUM (single article).
- webdav client, https://github.com/perry-mitchell/webdav-client plus local inspection of `webdav@5.11.0` sources (ETag stripping, `getPatcher`, `moveFile` Overwrite header, `minimatch` use). HIGH.
- Docker Hub tags (via API): `node:26-slim` (2026-11-11), `mongo:8.0`/`8.3` (2026-11-20), `hacdias/webdav` v5.17.3 (2026-10-30).
- Local WebDAV probe (hacdias/webdav v5, rclone latest, httpd 2.4.71), 2026-11-21, synthetic data only. HIGH.
- exceljs maintenance signals, search summaries of Snyk and package-health pages. MEDIUM (secondary).
- `npm audit` on a scratch install of webdav, exceljs, mammoth and turndown: four moderate findings (minimatch, uuid), both confirmed unreachable by reading the dependents' source. HIGH.
