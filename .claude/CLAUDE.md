<!-- GSD:project-start source:PROJECT.md -->

## Project

**mailbox-org-drive-rest-api**

A generic, self-hostable REST API that stores JSON records (mirrored to `.xlsx`), serves `.xlsx` sheets as JSON and `.docx` documents as Markdown, all backed by a mailbox.org Drive over WebDAV. It is for small organisations that already keep everything in mailbox.org Drive and cannot maintain a CMS or a separate storage service. The first adopter is a European civil-society non-profit whose website needs forms and Drive-edited content.

**Core Value:** Staff keep working in the Drive they already use, and developers get a safe, fast JSON API on top of it.

**Delivery priority:** the write path for website forms (collections + `.xlsx` mirror) ships first; read-only content follows.

### Constraints

- **Scope**: Generic and organisation-agnostic — no organisation names, folder layouts or schemas in the repo
- **Repository/licence**: Public repo, EUPL-1.2
- **Tech stack**: TypeScript on Node.js LTS; Fastify (native JSON Schema validation, OpenAPI; revisitable in phase 1); exceljs for `.xlsx`; mammoth (`.docx` → HTML) then turndown (HTML → Markdown) — mammoth's own Markdown output is deprecated; pino logs
- **Storage**: MongoDB is the system of record for collection records; Drive is the source of truth for sheets, documents and files, with MongoDB caching parsed/converted content keyed on ETag / last-modified
- **Portability**: A single container image plus MongoDB; must work without Kong or Keycloak
- **Security**: Least privilege on Drive (dedicated service account recommended); secrets never in the repo; anonymous endpoints hardened
- **Privacy**: Collection records are personal data; no personal data in logs
- **Data in repo**: Planning artefacts and fixtures contain only synthetic data (first adopter's AI tooling policy)
- **Testing**: Integration tests use the local Docker stack, never a real Drive
- **Development method**: Test-driven development: each behaviour starts as a failing test (RED), then the minimum code to pass (GREEN), then refactor. GSD `workflow.tdd_mode` is on.
- **Branching**: Trunk-based development: `main` is the trunk and is always green and releasable. Work lands on `main` directly or through short-lived branches merged within a day. There are no long-lived phase, milestone or release branches (GSD `git.branching_strategy: none`). Unfinished features are hidden behind config, not branches.
- **Licensing note**: MongoDB Community is SSPL (self-hosting fine); FerretDB (Apache-2.0) may be tested in CI if a fully OSI-licensed stack matters
- **Trademark**: "mailbox-org" used descriptively only; README states the project is unofficial

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Headline Findings (read these first)

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

### Database

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| MongoDB server | `mongo:8.0` (pin the minor in Compose) | System of record | 8.0 is the stable line. 8.3 tags exist on Docker Hub but are rapid releases, so avoid them for a long-lived self-hosted deployment. A standalone node is enough (no multi-document transactions needed). | MEDIUM |
| mongodb (official driver) | 7.9.1 | Data access | Needs Node >=20.19. Ships its own types. Collections are user-defined JSON Schemas, so a static-model ODM adds nothing. | HIGH |
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

- **ETag mangling.** It runs `etag.replace(/"/g, "")`. Store whatever it returns as an opaque token and never send it back in `If-Match`.
- **No retry, no timeout policy.** Add `p-retry` and an `AbortSignal` timeout yourself.
- **HTTP client is `node-fetch` 3.** Customisation is through `httpAgent` / `httpsAgent` and the global `getPatcher()`, which is process-wide, not per client. Do not patch it for one adapter instance.
- **Path encoding** of folders such as `Userstore/Last, First` is undocumented in the README. Cover it with a contract test in the early OX spike, because OX behaviour is unknown anyway.
- **Atomic mirror write.** `putFileContents(tmp)` then `moveFile(tmp, final)`. `moveFile` sends `Overwrite: T` by default. Use `customRequest` for anything fancier.
- **Audit noise.** `pnpm audit` flags `minimatch` in `webdav`. It is only used by the `glob` option on directory listings. Do not use that option, and treat it as an accepted finding.

### Mongo test strategy: Compose, not Testcontainers

### Local WebDAV server: `hacdias/webdav` v5

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

### TypeBox: yes, scoped

### exceljs risk (locked, so mitigate)

- Last release 4.4.0 on 2023-10-19. Forks exist (`@protobi/exceljs`, `@mui/x-internal-exceljs-fork`) but they are special-purpose. Do not adopt them now.
- `pnpm audit` flags `uuid` (exceljs depends on `^8.3.0`). exceljs only calls `v4()` without a buffer, and the advisory concerns v3/v5/v6 with a `buf` argument, so it is unreachable. Record it as an accepted finding. Do not force an override to uuid 14.
- Mitigations: wrap exceljs in one `workbook/` module (`writeMirror(rows, columns)`, `readSheet(buffer)`); `stat` the file before downloading and refuse files above a configured size, because exceljs loads whole workbooks in memory; cap rows per mirror.
- Exit path if it breaks: `read-excel-file` 9.3.20 (active, published 2026-11-19) for reads, and `write-excel-file` 4.1.1 for the simple header-plus-rows mirror. Avoid the npm `xlsx` package (0.18.5 is the abandoned SheetJS release with known advisories).

### API key hashing: SHA-256 via `node:crypto`

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

# Runtime

# Dev

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

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-fast` for a trivial task inline, with no subagents and no PLAN.md
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
