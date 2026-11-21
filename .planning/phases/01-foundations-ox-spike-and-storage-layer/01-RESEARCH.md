# Phase 1: Foundations, OX Spike and Storage Layer - Research

**Researched:** 2026-11-21
**Domain:** TypeScript/Fastify service skeleton, fail-fast config, PII-free logging, path-safe retry-aware WebDAV storage layer, OX (mailbox.org) WebDAV compatibility spike, Compose + GitHub Actions delivery
**Confidence:** MEDIUM overall. Toolchain and library behaviour: HIGH (installed and exercised in a scratch project this session). OX/mailbox.org WebDAV behaviour: LOW until the human-run spike (that is the task itself).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### Project-wide (carried forward)
- **D-01:** TDD for all behaviour (RED → GREEN → REFACTOR); `workflow.tdd_mode` on.
- **D-02:** Trunk-based development on `main`; no long-lived branches; `main` always green.
- **D-03:** Integration tests run only against the local Docker stack, never a real Drive; all fixtures synthetic.

#### OX WebDAV spike (STOR-01)
- **D-04:** Probe the user's own relatively fresh mailbox.org account (not a dedicated service account; holds no sensitive data).
- **D-05:** All probing happens inside one throwaway folder (e.g. `probe-<date>/`) that the spike deletes afterwards. Nothing outside it is read or written.
- **D-06:** Credentials come only from the user's shell environment (an app password if mailbox.org offers one). They are never written to disk, logs, fixtures or the repo.
- **D-07:** One-off manual spike, not a maintained repo script. Only the written compatibility matrix and synthetic fixtures (e.g. recorded PROPFIND/response XML with names and hosts anonymised) are kept.
- **D-08:** Trash and versions: probe over WebDAV, plus a short checklist the user follows in the OX web UI to confirm trash/version effects of overwrite and delete. The OX HTTP API is not probed in this phase.
- **D-09:** Don't contact mailbox.org support about rate limits now. The adapter uses conservative concurrency and backoff; revisit before production (stays in STATE blockers).
- **D-10:** The spike runs with the user present (it needs their credentials and web UI checks), so the plan must mark it as a human-action checkpoint, not an autonomous task.

#### Toolchain
- **D-11:** pnpm as package manager. — **Reversibility:** costly — lockfile, CI cache steps, Dockerfile and docs all assume pnpm.
- **D-12:** TypeScript 7 (native compiler) with Biome for lint and format; `tsc --noEmit` for typecheck. — **Reversibility:** costly — switching to ESLint means a new lint config and rule review across the codebase.
- **D-13:** Compile to `dist/` with `tsc`; the image runs compiled JS. No Node type-stripping at runtime.
- **D-14:** vitest as test runner (unit + integration against Compose).
- **D-15:** Node 26 only, both locally and in CI (no Node 24 matrix).

#### Config shape (FND-01, STOR-02)
- **D-16:** One `config.yaml` file, validated against a JSON Schema at startup; all errors listed in one failure. — **Reversibility:** one-way — the config file format is a published contract for deployers; changing it breaks existing deployments.
- **D-17:** Environment variables (and `*_FILE` variants) carry only secrets and deployment values (Mongo URI, WebDAV URL/user/password, port, log level). Structure (mounts, later collections) lives only in the file. The YAML references secrets with `${VAR}` placeholders.
- **D-18:** JSON Schemas (for later collections) may be `$ref`'d from sibling files next to `config.yaml`; no config directory merging.
- **D-19:** Mounts are addressed by name in API paths (e.g. `/files/{mount}/...`). Real Drive folder paths (such as `Userstore/Last, First`) are never exposed to clients or logs. — **Reversibility:** one-way — URL shape is part of the public API contract.

#### CI & delivery (DEV-03)
- **D-20:** GitHub Actions. Every push to `main` runs Biome, typecheck, unit tests, integration tests (Compose services) and the image build; any failure fails the pipeline.
- **D-21:** Publish the image to GHCR (`ghcr.io/europeanresolve/mailbox-org-drive-rest-api`) on green `main`, tagged `:sha-<short>` and a moving `:main`. Semver tags come later with releases.
- **D-22:** No FerretDB job for now; code stays within a portable MongoDB subset (single-document atomic ops, no transactions or change streams).
- **D-23:** Renovate (free hosted app for public repos) for dependency updates: grouped updates, pnpm/Dockerfile/GitHub Actions managers, `exceljs` pinned exactly. Chosen over Dependabot for more reliable support of new pnpm lockfile versions.

### Claude's Discretion
- Exact layout of the probe folder, the probe steps, and the matrix document format.
- Local dev WebDAV server choice (research recommends `hacdias/webdav:v5`), Compose file details, and Dockerfile base (`node:26-slim` recommended).
- Retry/backoff parameters and default concurrency cap (research suggests 2–4).
- Internal module layout (`DrivePath`/`PathGuard`, adapter contract suite structure).

### Deferred Ideas (OUT OF SCOPE)
- Asking mailbox.org support for WebDAV rate limits: before production (tracked in STATE blockers).
- Probing the OX HTTP API (hard delete, delete versions): v2.0 erasure work.
- FerretDB CI job: revisit only if a fully OSI-licensed stack becomes a requirement.
- Node 24 support: not planned.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| FND-01 | Config from file + env (`*_FILE` secrets); startup fails fast listing every config error | Config loader design (yaml `parseDocument`, `${VAR}` interpolation on parsed values, Ajv 2020 `allErrors`, semantic pass). Pitfalls: yaml error text echoes source lines, `Type.Record` pattern silently ignores bad keys. |
| FND-02 | `/health` alive; `/ready` fails when Mongo down, reports (does not fail on) Drive outage | Lazy-connect Mongo ping (verified ~1.5 s fail with `serverSelectionTimeoutMS`), cached single-flight Drive state, injectable checks for unit tests. |
| FND-03 | PII-free pino logs, canary test over error paths | Verified Fastify 5.12 harness: `logController` + `req`/`res`/`err` serializers + one `onResponse` log line; default config leaks in 6 of 20 lines in the prototype. `webdav` network errors embed the full URL (leak vector). |
| DEV-01 | One-command local stack | Verified `docker compose up -d --wait` (Mongo healthcheck, hacdias/webdav with tmpfs). hacdias image has no shell, so no in-image healthcheck. |
| DEV-02 | Unit + integration tests against local stack only | vitest 5 `projects` (unit / integration with `globalSetup`), unique db name + unique WebDAV subfolder per run. |
| DEV-03 | CI on every push to `main` | Workflow skeleton with verified action versions; GHCR publish needs explicit `packages: write` (repo default token is read-only). |
| DEV-04 | Synthetic data only | Fixture provenance rules, scrub-check step for OX fixtures, `.gitignore` already restricts office files to `test/fixtures/**`. |
| STOR-01 | Written OX WebDAV compatibility matrix + fixtures from a spike | Probe catalogue (P-01..P-20), UI checklist (U-01..U-10), script structure, anonymisation procedure, matrix format. Human checkpoint (D-10). |
| STOR-02 | Mount allow-list with `read` / `read-write`; outside-mount and write-to-read rejected | `Mounts` + `MountView` (write methods absent on `read` mounts, runtime guard too), startup overlap validation. |
| STOR-03 | Traversal corpus cannot escape a mount | Segment-array `DrivePath`; verified Fastify passes `..`, NUL, `\`, fullwidth dots through after one decode; NFKC check required. Corpus table below. |
| STOR-04 | `StorageAdapter` + WebDAV + in-memory under one contract suite | Interface, error taxonomy, observed hacdias behaviours that the contract must encode (MOVE missing source = 403, MKCOL existing = 405, recursive folder delete). |
| STOR-05 | Retry 429/503/network with backoff, never 401/403, cap concurrency, never deep PROPFIND | p-retry 9 context API verified from its types; p-limit; in-process fake HTTP server for fault injection and request recording (Depth header). |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

Treated with the same authority as locked decisions. [CITED: `.claude/CLAUDE.md`]

- Generic and organisation-agnostic: no organisation names, folder layouts or schemas in the repo.
- Public repo, EUPL-1.2. Secrets never in the repo. No personal data in logs.
- TypeScript on Node.js LTS; Fastify; pino logs; TypeBox only for static schemas (config, route params, envelopes); a separate strict Ajv for collection records (later phase).
- Planning artefacts and fixtures contain **only synthetic data**. Integration tests use the local Docker stack, never a real Drive.
- TDD (RED then GREEN then refactor). Trunk-based on `main`, always green; unfinished features hidden behind config, not branches.
- Single container image plus MongoDB; must work without Kong or Keycloak.
- Stack versions are pre-decided in CLAUDE.md (verified again below). "mailbox-org" used descriptively only.
- GSD workflow enforcement: file edits happen through a GSD command (`/gsd-execute-phase` for this phase).
- Project memory: fast-forward `main` and push after each GSD step; ask before auto-advancing. [CITED: user MEMORY.md]
- `workflow.nyquist_validation` is `false` in `.planning/config.json`, so no Validation Architecture section; a requirement-to-test map is in the table above and in "Test Strategy". `security_enforcement` is `true` (ASVS level 1), so a Security Domain section is included. [VERIFIED: .planning/config.json:25, 49]

## Summary

Phase 1 is a greenfield walking skeleton: no source code exists yet, only README, PROJECT-BRIEF, LICENSE and `.gitignore`. Everything the roadmap names is standard, and the decisions are already locked. The research effort went into the places where the locked stack is newest or riskiest. I installed the exact pinned versions in a scratch project and exercised them. The headline results: TypeScript 7.0.2 `tsc` (typecheck and emit with `.ts` import extensions rewritten), vitest 5.1.1 `projects` with a `globalSetup` only on the integration project, Biome 2.6.8 `noFloatingPromises` (nursery, works as `error`), pnpm 12.21.0 (exact versions saved by default, no build-script prompts for this dependency set), Fastify 5.12.8 with typed routes, `webdav` 5.11.0 against hacdias/webdav v5.17.3 in Compose, and a Docker multi-stage build on `node:26-slim` all work.

Four findings change how the planner should write tasks. (1) `webdav` network errors (`FetchError`) embed the full request URL, which for this product can be `Userstore/Last, First/...`, so no raw library error may ever reach a logger or response: the adapter must map to a path-free `StorageError`. (2) `yaml` parse errors embed the offending source line, which can be a secret, so config errors must be reported as code, line and column only. (3) hacdias/webdav behaves unlike the textbook in ways the contract suite must encode: MOVE of a missing source returns 403 (not 404), MKCOL on an existing folder is 405, `DELETE` of a non-empty folder is recursive and `Depth: infinity` PROPFIND is accepted, so the adapter itself must enforce "never deep" and refuse folder deletes. (4) `node:26-slim` ships no corepack, so pnpm must be installed with `npm install -g pnpm@12.21.0` in the Dockerfile; the `hacdias/webdav` image has no shell, so Compose cannot health-check it and the vitest `globalSetup` must poll it.

The OX spike cannot be researched from public sources (searches found no OX infostore documentation; the only public hints are mailbox.org's davfs2 guide telling users to set `if_match_bug 1` and `use_locks 0`). The plan should treat it as one human-action checkpoint using a throwaway raw-HTTP script plus a UI checklist, started early so its results can still shape adapter error mapping, with results recorded in `docs/ox-webdav-compatibility.md` and anonymised fixtures in `test/fixtures/ox/`.

**Primary recommendation:** Build the walking skeleton first (toolchain, Compose, CI, image, `/health` test green on `main`), then layer config, logging canary, `DrivePath`/mounts, `MemoryAdapter` + contract suite, `WebDavAdapter` + retry, and `/ready`; schedule the human OX spike in the first wave so it runs in parallel.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Config load, validation, secret resolution | API / Backend (startup) | — | Runs before the server listens; no client involvement. |
| `/health`, `/ready` | API / Backend | — | Operator-facing probes; `/ready` aggregates Mongo + cached Drive state. |
| PII-free request/error logging | API / Backend | — | Fastify serializers and error handler own what is logged. |
| Mount allow-list, `DrivePath`, traversal defence | API / Backend (domain layer) | — | Must precede every storage call; branded `ResolvedPath` makes escapes unrepresentable. |
| `StorageAdapter` (WebDAV, memory) | API / Backend (port + adapters) | External Drive (mailbox.org) | Only WebDAV-aware code; retry, concurrency, error taxonomy live here. |
| Drive availability state | API / Backend | — | Passive tracking plus cached probe; never a Drive call per `/ready`. |
| Local stack, CI, image build/publish | Build / Delivery | — | Compose (Mongo + WebDAV), GitHub Actions, GHCR. |
| OX compatibility matrix + fixtures | Documentation / Test assets | External Drive (spike only) | Human-run one-off; output is docs + fixtures. |

## Standard Stack

Versions read from the npm registry on 2026-11-21 and installed (exact pins) in a scratch project: all resolved and ran. [VERIFIED: npm registry, `npm view`; scratch install]

### Core
| Library | Version | Purpose | Notes verified this session |
|---------|---------|---------|------------------------------|
| typescript | 7.0.2 | typecheck (`tsc --noEmit`) and emit to `dist/` | Works with `module/moduleResolution: nodenext`, `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` (`./a.ts` emitted as `./a.js`), `erasableSyntaxOnly`, `verbatimModuleSyntax`. Typed Fastify/typebox/webdav/mongodb/p-retry/p-limit/ajv code typechecks. |
| fastify | 5.12.8 | HTTP | `disableRequestLogging` top-level option is **deprecated** in 5.12 (warning FSTDEP023, removed in 6): use `logController: new LogController({ disableRequestLogging: true })` (exported from `fastify`). |
| pino | 10.4.0 | bootstrap logger (config errors before Fastify exists) | Fastify embeds its own pino; add `pino` directly only for the bootstrap logger. |
| typebox | 1.4.7 | static schemas (config schema) | Default import `import Type from "typebox"`. Produces plain JSON Schema usable by Ajv 2020. `Type.Enum([...])` gives a clean `enum`; `Type.Union` of literals produces noisy `anyOf` errors. |
| ajv | 8.20.0 | config validation (`allErrors: true`, `strict: true`) | Under NodeNext ESM use `import { Ajv2020 } from "ajv/dist/2020.js"` (named); the default import is not constructable in TS. |
| yaml | 2.9.1 | config parse | Use `parseDocument` and read `doc.errors` (code + `linePos`); `DUPLICATE_KEY` is an error. |
| mongodb | 7.9.1 | `/ready` ping (full use in Phase 2) | No explicit `connect()` needed; first command auto-connects; unreachable host fails after `serverSelectionTimeoutMS` with `MongoServerSelectionError`. |
| webdav | 5.11.0 | WebDAV client inside `WebDavStorageAdapter` | See "WebDAV client facts". |
| p-retry | 9.0.0 | backoff | New context API: `shouldRetry({error, attemptNumber, retriesLeft, retriesConsumed, retryDelay})`, `onFailedAttempt` (may return a promise, usable to wait out `Retry-After`), `shouldConsumeRetry`, `maxRetryTime`, `signal`, `AbortError`. Defaults `retries: 10`, `maxTimeout: Infinity`: always set both. |
| p-limit | 7.3.3 | concurrency cap | — |

### Dev
| Library | Version | Purpose | Notes |
|---------|---------|---------|-------|
| vitest | 5.1.1 | unit + integration | `test.projects` works; `globalSetup` scoped to the integration project only. |
| @biomejs/biome | 2.6.8 | lint + format (`biome ci .` in CI) | `noFloatingPromises` lives in group `nursery`; config below flags an unawaited promise as an error. `biome init` now emits `"linter": {"rules": {"preset": "recommended"}}`. |
| @types/node | 26.6.6 | types | match Node major |
| pnpm | 12.21.0 | package manager (global, `packageManager` field) | Saves **exact** versions by default (no caret) in `package.json`. No dependency in this set has build scripts (no approval prompts). Not bundled with Node 26 images (no corepack). |

### Defer (do not install in Phase 1)
`@fastify/type-provider-typebox`, `fastify-plugin`, `ajv-formats`, `@fastify/*` plugins, `exceljs`, `mammoth`, `turndown`, `pino-pretty`, `@vitest/coverage-v8`. None is needed by a Phase 1 requirement. If `ajv-formats` is wanted for `format: uri` on config, note the NodeNext import quirk: `import addFormats from "ajv-formats"; addFormats.default(ajv)` (verified typechecks and runs). CLAUDE.md's STACK lists exceljs/mammoth stubs under Phase 1 in SUMMARY.md only; the Phase 1 requirement list does not include them, so skip them.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| p-retry 9 | ~15-line own loop | Locked stack uses p-retry; its context API is enough, including `Retry-After` via `onFailedAttempt`. |
| `webdav` client | undici + fast-xml-parser | Reconsider only if the spike shows the library hides path/ETag problems. |
| Compose in CI step | GitHub `services:` | hacdias needs a mounted config file; Compose reuses the dev stack unchanged. |

**Installation** (exact pins; pnpm 12 saves exact by default):
```bash
npm install -g pnpm@12.21.0   # also used in Dockerfile; node:26-slim has no corepack
pnpm add fastify@5.12.8 pino@10.4.0 typebox@1.4.7 ajv@8.20.0 yaml@2.9.1 mongodb@7.9.1 webdav@5.11.0 p-retry@9.0.0 p-limit@7.3.3
pnpm add -D typescript@7.0.2 vitest@5.1.1 @biomejs/biome@2.6.8 @types/node@26.6.6
```
`pnpm audit` reports one moderate finding, `webdav > minimatch` (GHSA-g3hv-75wg-m249), reachable only through the `glob` listing option which the adapter must never use. Accepted finding; if CI ever runs `pnpm audit`, use `--audit-level high` or ignore that GHSA. [VERIFIED: `pnpm audit` in scratch install]

## Package Legitimacy Audit

Run via `gsd_run query package-legitimacy check --ecosystem npm ...` on 2026-11-21. No `postinstall` scripts reported for any package. Every `SUS` verdict carries only the reason `too-new` (the *latest release* was published within the last ~30 days). All are long-established, high-download packages with source repos, pinned in the user's locked stack in CLAUDE.md. [VERIFIED: legitimacy seam + npm registry]

| Package | Registry | Weekly downloads | Source repo | Verdict | Disposition |
|---------|----------|------------------|-------------|---------|-------------|
| fastify | npm | 23.8M | github.com/fastify/fastify | SUS (too-new) | Flagged, consolidated checkpoint |
| typebox | npm | 16.4M | github.com/sinclairzx81/typebox | SUS (too-new) | Flagged, consolidated checkpoint |
| mongodb | npm | 22.8M | github.com/mongodb/node-mongodb-native | SUS (too-new; 7.9.1 published ~hours before research) | Flagged, consolidated checkpoint |
| p-retry | npm | 77.0M | github.com/sindresorhus/p-retry | SUS (too-new) | Flagged, consolidated checkpoint |
| vitest | npm | 194.7M | github.com/vitest-dev/vitest | SUS (too-new) | Flagged, consolidated checkpoint |
| @biomejs/biome | npm | 30.2M | github.com/biomejs/biome | SUS (too-new) | Flagged, consolidated checkpoint |
| @types/node | npm | 668.2M | DefinitelyTyped | SUS (too-new) | Flagged, consolidated checkpoint |
| webdav | npm | 255.6k | github.com/perry-mitchell/webdav-client | OK | Approved |
| p-limit | npm | 469.2M | github.com/sindresorhus/p-limit | OK | Approved |
| pino | npm | 81.6M | github.com/pinojs/pino | OK | Approved |
| yaml | npm | 331.9M | github.com/eemeli/yaml | OK | Approved |
| ajv | npm | 547.7M | github.com/ajv-validator/ajv | OK | Approved |
| typescript | npm | 450.7M | github.com/microsoft/TypeScript | OK | Approved |

**Packages removed ([SLOP]):** none.
**Packages flagged [SUS]:** fastify, typebox, mongodb, p-retry, vitest, @biomejs/biome, @types/node. `fastify` [WARNING: flagged as suspicious (too-new) - verify before using.] The protocol requires a human-verify gate before install; to avoid seven noisy checkpoints, the planner should add **one** `checkpoint:human-verify` task before the first `pnpm add` that shows the seven flagged names with their registry publish dates and asks the user to approve the lockfile diff. Also tag these names `[ASSUMED]` for provenance until that checkpoint passes (names come from the user's locked stack, not an authoritative-docs lookup).

Supply-chain note: pnpm docs state `minimumReleaseAge` defaults to 1440 minutes, `blockExoticSubdeps` and build-script blocking are on by default. In this session exact pins of versions only hours old (`typescript@7.0.2`, `mongodb@7.9.1`) still installed, so the behaviour for exact pins versus ranges is unconfirmed. [CITED: pnpm.io/supply-chain-security] [ASSUMED: interaction with exact pins] If a future `pnpm install` rejects a very fresh exact pin, that is the cause; do not disable the setting globally.

## Architecture Patterns

### System Architecture Diagram

```
              operator / orchestrator               developer / CI
                 |        |                              |
            GET /health  GET /ready               pnpm test / docker compose
                 |        |                              |
   +-------------v--------v------------+      +----------v-----------+
   | Fastify app  (buildApp(deps))     |      | Compose stack        |
   |  logController(off) + serializers |      |  mongo:8.0 (healthcheck)
   |  onResponse -> 1 PII-free log line|      |  hacdias/webdav:v5 (no healthcheck)
   |  error handler -> {type,code,status}     +----------+-----------+
   +---+-----------------------+-------+                 |
       | /ready                | (Phase 2+ routes)       |  integration tests
       |                       |                         |  (globalSetup polls both)
  +----v-----+          +------v-------+                 |
  | mongo    |          | Mounts       |                 |
  | ping     |          | name -> root |                 |
  | (2s)     |          | + mode       |                 |
  +----------+          +------+-------+                 |
                               | MountView (read | read-write; no write methods on read)
                        +------v-------+                 |
   config.yaml +env     | PathGuard /  |                 |
   (*_FILE)  -> loader  | DrivePath    |  rejects ..,\,NUL,empty, NFKC tricks
   (all errors, 1 fail) +------+-------+                 |
                               | ResolvedPath (branded, segments[])
                        +------v--------------------------+
                        | StorageAdapter (port)           |<--- same contract suite --- MemoryAdapter
                        |  WebDavAdapter                  |
                        |   p-limit(2..4) -> p-retry ->   |
                        |   webdav client (Depth 0/1 only)|
                        |   status/err -> StorageError    |
                        |   DriveHealth (cached state)    |
                        +------+--------------------------+
                               | HTTPS / WebDAV
                        mailbox.org Drive (spike) | hacdias/webdav (CI)
```

### Recommended Project Structure
```
.github/workflows/ci.yml
renovate.json
docker-compose.yml
dev/webdav.yml                  # dev/test only, synthetic credentials
Dockerfile  .dockerignore
biome.json  tsconfig.json  tsconfig.build.json  vitest.config.ts
config/config.example.yaml      # config/config.yaml is already gitignored
docs/ox-webdav-compatibility.md # STOR-01 matrix
src/
  server.ts                     # composition root: load config, build deps, listen, SIGTERM
  app.ts                        # buildApp(deps): routes, logging, error handler
  config/   schema.ts load.ts interpolate.ts errors.ts
  http/     logging.ts health.ts
  db/       mongo.ts            # client factory + ping
  storage/  drive-path.ts mounts.ts adapter.ts(StorageAdapter, StorageError)
            memory-adapter.ts webdav-adapter.ts retry.ts drive-health.ts
test/
  unit/  integration/  contract/storage-adapter.contract.ts
  fixtures/ox/                  # anonymised PROPFIND XML etc. (synthetic)
```
`test/` mirrors `src/`; `tsconfig.build.json` includes only `src`. Contract suite is a function `storageAdapterContract(name, makeAdapter)` imported by both `test/unit/memory-adapter.test.ts` and `test/integration/webdav-adapter.test.ts`.

### Suggested Plan Slicing (walking skeleton, mode mvp)
1. **Wave 1 (parallel):** (a) Skeleton: package/tsconfig/Biome/vitest, `buildApp` with `/health` test (RED then GREEN), Compose stack, Dockerfile, CI workflow, Renovate config, README dev section. This alone proves DEV-01..03 end to end. (b) OX spike preparation: author the probe script and UI checklist, then a **human-action checkpoint** to run it (D-10). Start early; do not block code on it.
2. **Wave 2 (parallel, depend on 1a):** config loader (FND-01); logging + canary harness (FND-03); `DrivePath`/`PathGuard`/`Mounts` + traversal corpus (STOR-02/03, pure code, no Fastify); `StorageAdapter` interface + `StorageError` + `MemoryAdapter` + contract suite (STOR-04).
3. **Wave 3:** `WebDavAdapter` (retry, limit, Depth rules, error mapping, request-recording tests) passing the contract suite against Compose (STOR-04/05); `/ready` + `DriveHealth` (FND-02); extend canary across adapter/config/Mongo error paths.
4. **Wave 4:** apply spike findings (error-mapping tweaks, fixture-replay unit tests), write `docs/ox-webdav-compatibility.md` (STOR-01), final canary sweep, STATE/blocker updates.

### Pattern 1: tsconfig pair (verified with TS 7.0.2)
```jsonc
// tsconfig.json (typecheck, includes tests; CI runs `tsc --noEmit`)
{ "compilerOptions": { "target": "es2024", "module": "nodenext", "moduleResolution": "nodenext",
  "lib": ["es2024"], "types": ["node"], "strict": true, "noUncheckedIndexedAccess": true,
  "exactOptionalPropertyTypes": true, "verbatimModuleSyntax": true, "isolatedModules": true,
  "skipLibCheck": true, "noEmit": true, "erasableSyntaxOnly": true,
  "allowImportingTsExtensions": true, "rewriteRelativeImportExtensions": true },
  "include": ["src", "test", "vitest.config.ts"] }
// tsconfig.build.json (emit; `tsc -p tsconfig.build.json`)
{ "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "outDir": "dist", "rootDir": "src", "sourceMap": true },
  "include": ["src"] }
```
Relative imports are written with `.ts` extensions (`import { a } from "./a.ts"`); vitest resolves them and `tsc` emits `.js`. `erasableSyntaxOnly: true` makes `tsc` reject enums (verified, error TS1294) which keeps `node src/server.ts` usable as an optional dev convenience (Node 26 strips types natively; verified `node src/b.ts` runs). Production still runs `dist/` (D-13). [VERIFIED: scratch project]

### Pattern 2: vitest projects with scoped globalSetup (verified)
```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { projects: [
    { test: { name: "unit", include: ["test/unit/**/*.test.ts"] } },
    { test: { name: "integration", include: ["test/integration/**/*.test.ts"],
        globalSetup: ["test/integration/global-setup.ts"], fileParallelism: false, testTimeout: 30_000 } },
  ] },
});
```
Scripts: `"test": "vitest run --project unit"`, `"test:integration": "vitest run --project integration"`, `"lint": "biome ci ."`, `"typecheck": "tsc --noEmit"`, `"build": "tsc -p tsconfig.build.json"`, `"stack:up": "docker compose up -d --wait"`, `"stack:down": "docker compose down -v"`. `globalSetup` must poll both services (Mongo ping; authenticated PROPFIND `Depth: 0` on `/` returns 207, unauthenticated returns 401) and throw one clear message if a service is missing. Each run uses `db = "it-" + randomUUID()` and a WebDAV folder `/run-<uuid>/`, removed in teardown.

### Pattern 3: Biome config (verified flags an unawaited promise)
```json
{ "linter": { "enabled": true, "rules": { "preset": "recommended", "nursery": { "noFloatingPromises": "error" } } } }
```
Run `biome ci .` (non-zero exit on any diagnostic or formatting difference). [VERIFIED: scratch project]

### Pattern 4: PII-free logging harness (verified prototype, 0 leaks vs 6 with defaults)
```ts
import Fastify, { LogController } from "fastify";
const app = Fastify({
  logger: { level, serializers: {
    req: (r) => ({ method: r.method, route: r.routeOptions?.url ?? "(unmatched)", id: r.id }),
    res: (r) => ({ status: r.statusCode }),
    err: (e) => ({ type: e.constructor?.name, code: e.code, status: e.statusCode }) } },
  logController: new LogController({ disableRequestLogging: true }),
});
app.addHook("onResponse", async (req, reply) => {
  req.log.info({ req, res: reply, ms: Math.round(reply.elapsedTime) }, "request");
});
app.setErrorHandler((err, req, reply) => {
  req.log.error({ err }, "error");                       // serializer drops message/stack
  reply.status(err.statusCode ?? 500).send({ title: "error" });
});
```
With Fastify defaults, the canary (`CANARY-7f3a@example.invalid`) appeared in 6 of 20 captured lines (query string in `req.url`, error `message`, 404 path). With the above, 12 lines and zero occurrences across: query string, thrown error whose message holds the canary, unmatched path containing the canary, body failing schema validation, truncated JSON body, wrong content type, oversize body (413). The Fastify-reported `reqId` is generated (`req-N`), not client supplied, as long as `requestIdHeader` stays unset. The canary test captures the stream passed as `logger.stream` (same trick as the prototype), and must also run the config-error path (canary placed in a secret value of an invalid file), Mongo-down (canary in the URI password; the driver messages observed contained no credentials), and WebDAV 401/404/503 with a canary in the path (see Pitfall 1).

### Pattern 5: Config loader (all errors in one failure)
Pipeline, accumulating issues rather than throwing at the first one:
1. Read file (`CONFIG_FILE` env or `--config`, default `config/config.yaml`; `.gitignore` already ignores `config/*.yaml` and allows `config/*.example.yaml`). Missing/unreadable file is one issue.
2. `parseDocument(text)`; map each `doc.errors` entry to `{ code, line, col }` only. Never print `error.message` (it embeds the source line and can be a secret, verified).
3. Interpolate `${NAME}` in **parsed string values** (never on raw text, so env contents cannot inject YAML). `NAME` resolves from `process.env.NAME`, else from the file at `process.env.NAME_FILE` (trim trailing `\r\n`). Both set, neither set, or unreadable file are issues naming the variable, never its value. No `${VAR:-default}` and no escaping (shortcut: add only if a literal `${` is ever needed).
4. Small fixed table of env overrides for deployment values `PORT` and `LOG_LEVEL`, with explicit integer parsing, because interpolation yields strings and the port is an integer.
5. Validate with Ajv 2020, `allErrors: true`, `strict: true`, schema built with TypeBox, `additionalProperties: false` everywhere. Map errors to `{ path: instancePath, keyword }`, no values.
6. Semantic pass (collected, not thrown): each mount path parsed by `DrivePath` rules; no mount at the Drive root; mount names match `^[a-z][a-z0-9-]{0,31}$`; no two mounts equal or nested when either is `read-write`; WebDAV URL parses and uses `https:` unless host is loopback.
7. On any issue: one `ConfigError` with the full list, printed once (bootstrap pino or stderr), exit code 1. On success return a deeply frozen typed `Config`; log only non-secret structure (port, level, mount names and modes).

Gotchas verified: TypeBox `Type.Record(Type.String({pattern}), ...)` compiles to `patternProperties`, so a key that violates the pattern is **silently accepted**. Pass `{ additionalProperties: false }` as the Record's options (verified: then `Bad_Name` yields an error) or model mounts as an array of `{name, path, mode}` and check uniqueness semantically. Use `Type.Enum([...])` not `Type.Union(Type.Literal...)` to avoid three errors for one bad value.

### Pattern 6: `DrivePath`, `PathGuard`, `Mounts`, branded `ResolvedPath`
- Canonical form is a **segment array**. Input arrives decoded exactly once (Fastify decodes the wildcard param once: verified `%2e%2e` → `..`, `a%2Fb` → `a/b`, `%252e%252e` stays literal `%2e%2e`, NUL, `\` and fullwidth dots (`．．`) pass through untouched; Fastify does not collapse dot segments and `//` yields empty segments). The guard never decodes again.
- Reject a segment if: empty, `.` or `..` (also after `normalize("NFKC")`: verified `"．．"`, `"․․"`, `"‥"`, `"﹒﹒"` all normalise to `..`, `"／"` to `/`), contains `/`, `\`, NUL or any control character (also checked on the NFKC form), or exceeds a length cap (255 UTF-8 bytes). Then normalise to NFC for storage and comparison (macOS-originated NFD names versus NFC config; whether OX treats them as equal is a spike row).
- A literal `%2e%2e` segment is a legal file name; WebDAV URL building must encode `%` (`encodeURIComponent` per segment).
- Mount = `{ name, rootSegments, mode }`. `resolve(mountName, relSegments)` returns a `ResolvedPath` (class with a module-private constructor/symbol) holding the full Drive segments. Containment is checked as an array prefix check against the mount root (never `startsWith` on strings, `/a` vs `/ab`), although construction by appending already-validated segments makes escape structurally impossible.
- `Mounts.open(name)` returns a `MountView`: for `read` it exposes only `list/stat/read`; for `read-write` also `write/mkdir/move/delete`. Add a runtime guard too (calling a write method through a cast throws `StorageError{kind:"read-only-mount"}`) so STOR-02 "write to a read mount is rejected" is a runtime-tested behaviour, not only a type-level one. `move` takes two `ResolvedPath` values from the same mount.
- Traversal corpus (input after the single decode; each must reject or stay inside): `..`, `a/../b`, `../x`, `a/..`, `.`, empty and `//`, trailing slash, `a\b`, `a\..\b`, NUL (`\u0000x`), `%2e%2e` literal (allowed, stays a name), `．．`, `․․`, `‥`, `／`, `..%2f` literal (allowed name), tab/newline/DEL, 300-char segment, `Müller` vs `Müller` (equal after NFC), absolute-looking `/etc`, Windows `C:` (legal name, stays inside). Plus a seeded random generator over an alphabet of `. / \ % 2 e NUL ．／ a ü` (no extra dependency; add `fast-check` only if shrinking is wanted) asserting `resolve(mount, x)` either throws or yields segments starting with the mount root and containing no `.`/`..`/empty.
- Log/error policy (D-19): messages and logs carry the mount **name** and, if a path reference is needed, `ref = sha256(segments).slice(0, 8)`, never the segments. Mount `path` values come from config and may themselves be a person's name.

### Pattern 7: `StorageAdapter` interface, error taxonomy
```ts
interface StatEntry { name: string; kind: "file" | "dir"; size: number; etag: string | null; lastModified: Date }
interface StorageAdapter {
  stat(p: ResolvedPath): Promise<StatEntry>;
  list(p: ResolvedPath): Promise<StatEntry[]>;                       // shallow only, self excluded
  read(p: ResolvedPath, o?: { maxBytes?: number }): Promise<Buffer>; // see Open Question 1
  write(p: ResolvedPath, body: Buffer): Promise<StatEntry>;          // returns new stat (etag may be null)
  mkdir(p: ResolvedPath): Promise<void>;
  move(from: ResolvedPath, to: ResolvedPath, o: { overwrite: boolean }): Promise<void>;
  delete(p: ResolvedPath): Promise<void>;                            // files only, see below
}
type StorageErrorKind = "not-found" | "conflict" | "forbidden" | "unauthorized" | "rate-limited"
  | "unavailable" | "too-large" | "insufficient-storage" | "read-only-mount" | "invalid-path";
class StorageError extends Error { kind; op; status?; }              // message = kind + op only, no path, no cause message
```
Status mapping (adapter-private): 401 `unauthorized` (no retry, opens a short cooldown circuit); 403 `forbidden` (no retry); 404 `not-found`; 405 on MKCOL, 409, 412, 423 `conflict`; 413 `too-large`; 507 `insufficient-storage`; 429 `rate-limited` (retry); 502/503/504 and network errors/timeouts `unavailable` (retry); everything else `unavailable`, no retry. Network errors from `webdav` are node-fetch `FetchError` with `code` (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE`, `ENOTFOUND`) and no `status`; HTTP errors are `Error` with `status` and `response` (`response.headers.get("retry-after")` works). [VERIFIED: probes against hacdias and a scripted node http server]

Rules derived from the observed hacdias behaviour (the contract suite must encode them; `MemoryAdapter` must mimic them):
- MOVE of a missing source returns **403**, not 404, and MOVE into a missing parent returns 403. Adapter rule: on a MOVE failure with 403/409/412, `stat(source)`; if missing map to `not-found`, else keep the mapped kind. One extra Depth 0 PROPFIND only on the error path.
- MOVE `Overwrite: F` onto an existing file is 412 → `conflict`; `Overwrite: T` replaces and returns 204.
- MKCOL on an existing folder is 405 and with a missing parent 409; PUT into a missing parent is 409. All map to `conflict`.
- `DELETE` on a **non-empty folder succeeds recursively (204)**. v1 has no use for folder deletion, so `delete` is file-only: `stat` first (Depth 0) and reject folders with `conflict`. This prevents one bad call from wiping a mount.
- PROPFIND `Depth: infinity` is accepted by hacdias, so "never deep" must be enforced by the adapter (only ever `getDirectoryContents` without `deep: true`; the client sends `Depth: 1`, and `stat` sends `Depth: 0`) and proven by a request-recording test.
- `If-Match` with a bogus value is ignored by hacdias (201); never design on it. ETag for directories is `null`.
- `stat`/`list` return `etag` already stripped of quotes by the library; treat it as an opaque equality token.

### Pattern 8: WebDAV adapter construction (verified calls)
```ts
const client = createClient(baseUrl, {              // baseUrl keeps the /servlet/webdav.infostore/ prefix (verified)
  username, password,
  headers: { "User-Agent": "mailbox-org-drive-rest-api/<ver> (+<contact>)" },
  maxContentLength: LIMIT, maxBodyLength: LIMIT,    // [CITED: webdav types.d.ts] runtime effect not exercised
  entityDecoder: { limit: { maxTotalExpansions: 1000, maxExpandedLength: 1_000_000 } }, // [CITED: types.d.ts]
});
const PROPFIND_BODY = `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getetag/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>`;
await client.getDirectoryContents(path, { data: PROPFIND_BODY, headers: { "Content-Type": "application/xml" }, signal });
await client.stat(path, { data: PROPFIND_BODY, headers: { "Content-Type": "application/xml" }, signal });
```
Verified on the wire: with no `data` the client sends an empty-body PROPFIND (allprop, bulky on OX), `data` replaces it, listing sends `Depth: 1`, stat `Depth: 0`, `putFileContents(Buffer)` sends `Content-Length`, `moveFile` sends `Overwrite: T`, the client default `Content-Type` for PROPFIND is `text/plain;charset=UTF-8` (hence the explicit header above; whether OX cares is spike row P-02), and paths with `, & # % +` and umlauts round-trip (`Last%2C%20First`). Every call takes an `AbortSignal`: combine the per-request timeout with `AbortSignal.any([AbortSignal.timeout(ms), callerSignal])`, and retry only when the timeout fired, not when the caller aborted.

Wrapper order per call: `limit(() => pRetry(() => attempt(), opts))` so the concurrency slot is held across retries and backoff (keeps the global request rate low). Recommended defaults (discretion, not OX-derived): concurrency 2 (config max 4); `retries: 4`, `minTimeout: 500`, `factor: 2`, `maxTimeout: 8000`, `randomize: true`, `maxRetryTime: 60_000`; `Retry-After` honoured up to 30 s by awaiting inside `onFailedAttempt`; per-request timeout 15 s for stat/list/mkdir/move/delete, 60 s for read/write; `shouldRetry` allows only 429, 502, 503, 504 and network/timeout errors, and returns false for 401/403 and all other 4xx. `move`/`delete` after a **network** error (request may have executed): verify via `stat` instead of blind retry; `delete` treats 404 on a retried attempt as success; `move` treats 404-on-source with destination present as success. Tests inject tiny `minTimeout` and a stub sleep so the unit suite stays fast.

Test the adapter against an in-process `node:http` server (fault injection and recording, verified feasible): scripted `503, 503, 207` sequence → 3 requests and success; `429` + `Retry-After: 0`; `401` → exactly 1 request; `403` → 1; connection destroyed → retried; all PROPFIND requests carry `Depth` of `0` or `1`; N concurrent calls never exceed the cap (server counts in-flight). These tests need no Docker.

### Pattern 9: `/ready`, `DriveHealth`
`/health` returns `200 {status:"ok"}` with no dependencies. `/ready`: Mongo `db("admin").command({ping:1})` under a 2 s limit (client created with `serverSelectionTimeoutMS: 1500`, no `connect()` at boot, so the server starts and `/health` answers even when Mongo is down); failure gives `503 {status:"not-ready", mongo:"down", drive:<state>}`. Drive state is `unknown | up | degraded | unavailable` from `DriveHealth`: passive tracking of adapter outcomes plus a cached probe (a `stat` of one mount root, single-flight, result cached ~30 s, refreshed lazily by `/ready`), so probes never trigger a Drive call per request. Drive `unavailable` still returns `200` with the state in the body. After a 401/403 the adapter fails fast for a 60 s cooldown (no requests) and reports `unavailable`, avoiding repeated bad-credential logins. `buildApp(deps)` takes `{ mongoPing, driveHealth }` so unit tests use fakes and an integration test points a real `MongoClient` at a closed port (no container juggling).

### Pattern 10: Compose, Dockerfile, CI (verified unless noted)
`docker-compose.yml` (brought up in 6.5 s with `--wait`; tmpfs keeps runs clean):
```yaml
name: mailbox-org-drive-rest-api-dev
services:
  mongo:
    image: mongo:8.0
    ports: ["127.0.0.1:27017:27017"]
    tmpfs: [/data/db]
    healthcheck: { test: ["CMD","mongosh","--quiet","--eval","db.adminCommand('ping').ok"], interval: 3s, timeout: 5s, retries: 20, start_period: 5s }
  webdav:
    image: hacdias/webdav:v5      # no shell in image: no healthcheck possible
    ports: ["127.0.0.1:6065:6065"]
    volumes: ["./dev/webdav.yml:/etc/webdav/config.yml:ro"]
    tmpfs: [/data]
```
`dev/webdav.yml`: `address: 0.0.0.0`, `port: 6065`, `directory: /data`, `permissions: CRUD`, one synthetic user (`dev` / `dev-password`). The image exposes 6065 and reads `/etc/webdav/config.yml` by default. `mongo:8.0` resolved to mongod 8.0.38 and has `mongosh`.

`Dockerfile` (built successfully; final image 429 MB; the `HEALTHCHECK` line is unexercised):
```dockerfile
FROM node:26-slim AS build
RUN npm install -g pnpm@12.21.0
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm exec tsc -p tsconfig.build.json && pnpm prune --prod

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD ["node","-e","fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node","dist/server.js"]
```
`.dockerignore`: `node_modules dist .git .planning test tmp config/*.yaml .env*`. Slim has no curl, hence the `node -e fetch` healthcheck. Pin the base by digest later (Renovate `config:best-practices` does this).

`.github/workflows/ci.yml` skeleton (action majors from the GitHub releases API: checkout v7.0.1, setup-node v7.1.0, pnpm/action-setup v6.1.1, docker/login-action v4.8.0, docker/build-push-action v7.4.0, docker/setup-buildx-action v4.4.1, docker/metadata-action v6.2.0; YAML itself not executed here):
```yaml
on: { push: { branches: [main] }, pull_request: {} }
concurrency: { group: "ci-${{ github.ref }}", cancel-in-progress: "${{ github.ref != 'refs/heads/main' }}" }
permissions: { contents: read }          # repo default token is read-only (verified via API)
jobs:
  check:       # checkout; pnpm/action-setup@v6 (reads packageManager); setup-node 26 cache pnpm;
               # pnpm install --frozen-lockfile; pnpm lint; pnpm typecheck; pnpm test
  integration: # same setup; docker compose up -d --wait; pnpm test:integration; if: always() docker compose down -v
  image:
    needs: [check, integration]
    permissions: { contents: read, packages: write }
    # buildx; login-action to ghcr.io with GITHUB_TOKEN only if event is push;
    # metadata-action tags: type=ref,event=branch (-> main) and type=sha (-> sha-<short>);
    # build-push-action push: ${{ github.event_name == 'push' }}
```
Image name must be lowercase `ghcr.io/europeanresolve/mailbox-org-drive-rest-api`. The first GHCR push creates the package; its visibility (public) and the org's "allow GITHUB_TOKEN to publish packages" setting may need a one-time human action in GitHub settings [ASSUMED]. Compose is on the runner image (`docker compose version` works locally; GitHub-hosted runners ship Compose v2, [ASSUMED]).

`renovate.json` (D-23): `{"extends": ["config:best-practices"], "packageRules": [{"matchManagers": ["npm"], "groupName": "npm dependencies", "matchUpdateTypes": ["minor","patch"]}, {"matchPackageNames": ["exceljs"], "rangeStrategy": "pin"}], "lockFileMaintenance": {"enabled": true}}`. `config:best-practices` includes Docker and GitHub Action digest pinning, a minimum release age for npm, and weekly lockfile maintenance [CITED: docs.renovatebot.com/presets-config]. Installing the Renovate GitHub App on the repo is a human action. Pnpm is handled by Renovate's npm manager [ASSUMED]; confirm the first Renovate PR updates `pnpm-lock.yaml`.

### Anti-Patterns to Avoid
- Logging or returning a raw library error (`webdav`, `mongodb`, `yaml`, Ajv with `verbose`): map first.
- Writing a Phase 1 test that talks to a real Drive (violates D-03). The OX spike is a manual script outside the test suite; never wire an env-gated "run the contract suite against OX" test into the repo.
- `path.join` / `startsWith` / `new URL("/abs", base)` on Drive paths (the last silently discards the `/servlet/webdav.infostore/` base: verified `new URL("/Userstore/Last, First/f.xlsx", "https://dav.mailbox.org/servlet/webdav.infostore/").href` is `https://dav.mailbox.org/Userstore/Last,%20First/f.xlsx`). Let the `webdav` client build URLs from decoded segments.
- Retrying 401/403, or retrying MOVE/DELETE blindly after a network error.
- Designing on `LOCK` or `If-Match` (neither dev server enforces `If-Match`; hacdias returned 201 for a bogus value).
- Passing `deep: true` or `glob` to `getDirectoryContents`.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PROPFIND XML parsing and URL/href handling | own XML parser | `webdav` client (`stat`, `getDirectoryContents`) with an explicit PROPFIND body | Verified: handles `Depth`, encoding, self-entry removal, quote-stripped etags; entity expansion limits are a client option. |
| Retry/backoff with jitter | ad hoc loops | `p-retry` 9 | `shouldRetry`/`onFailedAttempt`/`maxRetryTime` cover every rule here. |
| Concurrency limit | counters/semaphores | `p-limit` | One line. |
| Config validation + error aggregation | custom validators | Ajv 2020 `allErrors` + TypeBox schema + `yaml` `parseDocument` | Gives every error in one pass. |
| API of "single decode" for routes | custom URL decoding | Fastify wildcard param (decoded once) plus `DrivePath` segment checks | Double decoding is a bug source. |
| Dev WebDAV server | custom node server | `hacdias/webdav:v5` | 15 MB image, all verbs the adapter needs. |
| Test HTTP fault injection | module mocks of `webdav` | in-process `node:http` server | Exercises the real client (status/headers/aborts/Depth). |

**Key insight:** the only custom logic this phase should contain is the part nobody else can supply: path safety, error taxonomy/mapping, and what to log. Everything else is wiring.

## Runtime State Inventory

Not applicable: greenfield phase, no rename/refactor/migration. Nothing to inventory.

## Common Pitfalls

### Pitfall 1: Library errors and URLs leak personal data
**What goes wrong:** `webdav` network failures produce `FetchError: request to http://.../dir-CANARYpath/Last%2C%20CANARY failed, reason: connect ECONNREFUSED` (verified leak). A pino `err` serializer or a global error handler prints it.
**Why it happens:** the URL (a person's folder name) is in the message; default serializers print `message` and `stack`.
**How to avoid:** adapter catches every library error and throws `StorageError` built from `kind/op/status` only; never set `cause` to the raw error; the `err` serializer emits `{type, code, status}`. Canary test across 401/404/503/network paths.
**Warning signs:** any line in captured logs containing `Userstore`, a folder name or `%2C`.

### Pitfall 2: Config errors echo secrets
**What goes wrong:** `YAMLParseError.message` contains the source line (verified: `password: sEcr3t-value` appeared in the message), so printing the message leaks the secret.
**How to avoid:** report only `code`, `line`, `col`; Ajv errors only `instancePath` + `keyword`; interpolation errors only variable names. Canary test with a secret on the offending line.

### Pitfall 3: Silent acceptance of bad mount names
**What goes wrong:** a mount named `Bad_Name` passes validation because `Type.Record(String({pattern}))` becomes `patternProperties`.
**How to avoid:** `additionalProperties: false` on the Record (verified) or an array of mounts plus a uniqueness check; add a RED test with an invalid name first.

### Pitfall 4: Believing the dev server is OX
**What goes wrong:** hacdias ignores `If-Match`, returns 403 for MOVE failures and accepts `Depth: infinity`; OX may differ in every one of those.
**How to avoid:** the contract suite asserts semantic outcomes (`StorageError.kind`), not raw statuses; the adapter enforces its own rules (no deep PROPFIND, files-only delete, MOVE-failure classification); the matrix records OX differences; fixtures from OX feed replay tests.

### Pitfall 5: `docker compose --wait` does not wait for hacdias/webdav readiness
**What goes wrong:** the image has no shell, so no healthcheck exists; `--wait` reports it healthy once running. First test hits connection-refused.
**How to avoid:** `globalSetup` polls an authenticated PROPFIND with a short retry loop (about 10 s) before tests start.

### Pitfall 6: Fresh packages and pnpm supply-chain defaults
**What goes wrong:** a locked version published within the minimum release age may be refused on a clean install, or Renovate proposes versions younger than a day.
**How to avoid:** commit the lockfile, install with `--frozen-lockfile` in CI and Docker; keep Renovate's release-age rule (`config:best-practices`). Do not turn off `strictDepBuilds`/`blockExoticSubdeps`.

### Pitfall 7: Contract suite coupled to hacdias quirks
**What goes wrong:** asserting `403` for a missing MOVE source passes on hacdias and fails on OX or memory.
**How to avoid:** contract expects `not-found` and the adapter converts via the stat-on-error rule; keep raw-status assertions in WebDAV-only tests.

### Pitfall 8: Unbounded retry wait inside the concurrency slot
**What goes wrong:** `Retry-After: 3600` parks a slot forever.
**How to avoid:** cap honoured `Retry-After` at 30 s, set `maxRetryTime`, and surface `rate-limited` to the caller afterwards.

### Pitfall 9: Spike fixtures carrying real data
**What goes wrong:** recorded XML contains the real username, e-mail, host and numeric IDs.
**How to avoid:** anonymisation step plus a scrub grep using the real strings supplied via environment variables (so the repo never holds them), and a human review of every fixture before commit.

## Code Examples

### Ajv 2020 under NodeNext (verified typecheck and run)
```ts
import { Ajv2020 } from "ajv/dist/2020.js";
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(ConfigSchema);                // ConfigSchema built with typebox
if (!validate(doc)) issues.push(...(validate.errors ?? []).map(e => ({ path: e.instancePath, keyword: e.keyword })));
```

### YAML errors without source text (verified)
```ts
import { parseDocument } from "yaml";
const doc = parseDocument(text);
const yamlIssues = doc.errors.map(e => ({ code: e.code, line: e.linePos?.[0]?.line, col: e.linePos?.[0]?.col }));
```

### p-retry with `Retry-After` and non-retryable statuses (API per p-retry 9 types)
```ts
await pRetry(() => attempt(signal), {
  retries: 4, minTimeout: 500, factor: 2, maxTimeout: 8000, randomize: true, maxRetryTime: 60_000,
  shouldRetry: ({ error }) => isTransient(error),            // 429/502/503/504/network/timeout only
  onFailedAttempt: async ({ error, retryDelay }) => {
    const ra = retryAfterMs(error);                          // from error.response.headers.get("retry-after")
    if (ra && ra > retryDelay) await sleep(Math.min(ra, 30_000) - retryDelay);
  },
});
```

### Request-recording fake server for adapter tests (verified pattern)
```ts
const seen: { m: string; u: string; depth?: string }[] = [];
const srv = http.createServer((req, res) => { seen.push({ m: req.method!, u: req.url!, depth: req.headers.depth as string });
  /* respond per script: 503, 503, then 207 multistatus */ });
// assert: seen.filter(r => r.m === "PROPFIND").every(r => r.depth === "0" || r.depth === "1")
```

## OX Spike Design (STOR-01, human checkpoint)

**Goal:** fill the matrix with *observed* values and capture anonymised fixtures. It runs once, with the user present (D-10). Confidence for every OX claim is LOW until this is done. Public sources found: base URL `https://dav.mailbox.org/servlet/webdav.infostore/Userstore` (personal folder named after the user), application passwords exist (Settings > Security > Application passwords, predefined type "WebDAV Client", each restricted to its app), and the davfs2 guide sets `if_match_bug 1` and `use_locks 0`; the guide says nothing about limits, quota, trash or versions. [CITED: kb.mailbox.org/en/business/drive-article/webdav-for-linux/, kb.mailbox.org/en/private/security-and-privacy/application-passwords-for-external-programs/] An unrelated forum report of 401 with rclone and an app password on the Userstore endpoint exists [LOW, not retrieved].

**Structure**
1. *Prep (autonomous task):* write a single dependency-free Node ESM script (global `fetch`, `redirect: "manual"`, HTTP/1.1) plus a UI checklist; unit-test only its pure helpers (URL joiner, anonymiser) with synthetic input. Keep the script as an unmaintained phase artefact under `.planning/phases/01-.../spike/` (or run from the gitignored `tmp/`); results never go in the repo unscrubbed. D-07 says "not a maintained repo script": keep it out of `src/`, `test/` and CI.
2. *Human step:* user creates an empty folder `probe-<yyyy-mm-dd>` in the OX Drive UI, creates an app password (type WebDAV Client), exports `OX_WEBDAV_URL` (full URL of that folder), `OX_WEBDAV_USER`, `OX_WEBDAV_PASSWORD` in the shell only, and runs the script. The script refuses to start unless the URL's last segment matches `^probe-\d{4}-\d{2}-\d{2}/?$` and the folder is empty; every URL is built by joining encoded segments under that root (nothing outside is touched, D-05); it never prints credentials or the full URL; raw responses go to `tmp/ox-spike/<date>/` (gitignored). Between probe groups it pauses for the UI checklist and records the user's answers.
3. *Single bad-credential probes are not performed* (lockout risk); 401 is recorded only if it occurs naturally. Rate behaviour: at most about 20 sequential and 3 x 6 concurrent `Depth: 0` PROPFINDs, recording latency and any 429/503/`Retry-After`; no stress testing (provider terms; D-09).
4. *Post-run (autonomous task):* anonymise, write `docs/ox-webdav-compatibility.md` and `test/fixtures/ox/*`, add fixture-replay unit tests (serve recorded XML from the fake server to the adapter: self-entry skip, base-path stripping, encoded names, etag quoting), run the scrub grep, and have the user review. Delete the probe folder (script does it, then the user confirms emptied trash in the UI).

**Probe catalogue (matrix rows; record status, relevant headers, short note, fixture file)**

| ID | Probe | Why it matters |
|----|-------|----------------|
| P-01 | `OPTIONS` on probe root: `DAV`, `Allow`, `Server`, `MS-Author-Via` headers | LOCK/VERSION-CONTROL classes, supported verbs |
| P-02 | PROPFIND `Depth: 0` on file and folder with explicit prop body and `Content-Type: application/xml`, and again with empty body (allprop) and `text/plain` | href form, namespace prefixes, `getetag` shape (quoted/weak), `getlastmodified` format, extra props, whether body/content-type matters |
| P-03 | PROPFIND `Depth: 1` on a folder containing names with `, ` `&` `#` `%` `+` ü emoji and an NFC/NFD pair | href encoding vs request encoding, self-entry position, listing completeness |
| P-04 | PROPFIND `Depth: infinity` once on a tiny folder; and header omitted | rejected or expensive (adapter never sends it) |
| P-05 | PUT new file (explicit `Content-Length`), then PUT with chunked `Transfer-Encoding` | 201/204, response `ETag`, 411 on chunked |
| P-06 | ETag stability: PROPFIND x2; HEAD/GET etag equals PROPFIND etag; PUT identical bytes; PUT different bytes within the same second; MOVE rename; edit folder sibling | stable validator? fallback to `(lastmod,size)` needed? |
| P-07 | GET with `If-None-Match` (quoted, unquoted, weak) | 304 vs 412 (reported by a Cryptomator user, LOW) |
| P-08 | PUT with `If-Match` correct / bogus; PUT with `If-None-Match: *` on existing | enforced or ignored (design avoids relying on it) |
| P-09 | `LOCK` exclusive write on a file; PUT without token; `UNLOCK` | 423/405/501; confirms "do not use locks" |
| P-10 | MOVE new name; MOVE onto existing with `Overwrite: F` and `T`; MOVE onto itself; MOVE missing source; MOVE into missing parent; repeat a successful MOVE | atomic replace? status codes, retry semantics (404 after success) |
| P-11 | MKCOL new / existing / missing parent / name with `, `; PROPFIND on folder URL without trailing slash | 201/405/409, redirects |
| P-12 | DELETE file, DELETE non-empty folder, DELETE missing, PUT same name after delete | recursion, 404, name reuse |
| P-13 | GET on folder, GET missing, HEAD | statuses |
| P-14 | Names: `A.txt` vs `a.txt`, trailing dot/space, `: ? * " < > \| \`, 255+ chars, NFC vs NFD duplicate, emoji | case sensitivity, forbidden-character status, normalisation |
| P-15 | Path encoding of `Last, First`: request as `%20`/`%2C`, raw comma, `+`, `%2F` in a segment | which forms resolve; matches adapter URL building |
| P-16 | PUT 1 MB and 10 MB synthetic bytes; PROPFIND `quota-available-bytes`/`quota-used-bytes` | size limits, quota props |
| P-17 | Temp-name pattern: PUT `.name.xlsx.<rand>.tmp` then MOVE `Overwrite: T` over `name.xlsx`, versus PUT directly over `name.xlsx` | feeds Phase 3 mirror decision (feeds U-03/U-04) |
| P-18 | Throttle observation (limits above) and connection reuse (`Connection`/`Keep-Alive` headers) | backoff/concurrency defaults |
| P-19 | Webdav-library smoke (same script, second part): `createClient`, `stat`, `getDirectoryContents`, `putFileContents`, `moveFile`, `deleteFile` on the probe folder | confirms the actual client copes with OX XML/encoding (ETag quote stripping, base path) |

**OX web UI checklist (user answers y/n/notes; maps to D-08)**

| ID | Check |
|----|-------|
| U-01 | After PUT of the same file three times over WebDAV: how many versions does Drive > Versions list? |
| U-02 | Does a PUT of byte-identical content still create a version? |
| U-03 | After MOVE over an existing file: versions of the destination, file identity preserved (create a share link before, still valid after?) |
| U-04 | After the temp+MOVE pattern: is the `.tmp` name visible (file list, recent files, notifications)? any leftover? |
| U-05 | After DELETE of a file over WebDAV: is it in the Trash folder? restorable? did its versions come along? |
| U-06 | After DELETE of a non-empty folder: one trash entry or per-child entries? |
| U-07 | Do trash and versions consume quota (usage display before/after)? |
| U-08 | Can an item be deleted permanently from the Trash in the UI (confirms a manual erasure step for v2)? |
| U-09 | How are NFC/NFD and `, ` names displayed; is `Userstore/Last, First` the same folder the UI shows? |
| U-10 | Does the UI show version/trash behaviour differently for MOVE-renamed files? |

**Matrix document format** (`docs/ox-webdav-compatibility.md`): header (date, account class "personal, fresh", method), then one table per area (Discovery, PROPFIND/ETag, Conditional requests, Locking, MOVE/COPY, Folders/DELETE, Names/encoding, Versions/trash, Limits) with columns `ID | Probe | RFC/dev-server expectation | Observed on OX | Impact on design | Fixture`. A final "Consequences" list states: ETag usable as validator or fallback needed, MOVE-over-existing vs plain PUT for Phase 3, adapter mapping changes, `Last, First` encoding result, open items for support/production. Rows that could not be tested say so with a reason; none are left blank. Every `Observed on OX` cell is backed by a fixture or a pasted status line; unverified rows are marked `[ASSUMED]`.

**Fixture anonymisation:** replace host with `dav.example.invalid`, the user's folder segment with `Last, First`, any e-mail with `user@example.invalid`, numeric file/folder IDs with same-length digits from a fixed pseudo-random sequence, remove cookies and `Set-Cookie`/`Authorization`. Keep namespace prefixes, element order, etag shape (quoting, separators, length), date formats. Scrub check before commit: `grep -rniE "$OX_SCRUB_PATTERN" test/fixtures/ox docs` where the pattern (real username, name, host) lives only in the user's shell.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Fastify `disableRequestLogging` top-level | `logController: new LogController({...})` | deprecated in 5.12, removed in 6 | Use the new option from the first commit |
| ESLint + typescript-eslint | Biome 2 (`biome ci`) | locked D-12 | TS 7 native `tsc`; type-aware lint thin, `noFloatingPromises` is nursery |
| corepack-provided pnpm | `npm install -g pnpm@12.21.0` / `pnpm/action-setup` | Node 25+ images dropped corepack (`node:26-slim` verified) | Dockerfile and docs must install pnpm explicitly |
| `ts-node`/`tsx` dev runner | Node native type stripping (dev only) | Node 24+ | Optional; guarded by `erasableSyntaxOnly` |

**Deprecated/outdated:** `@sinclair/typebox` (use `typebox` 1.x); Fastify default request logging (leaks URLs).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Seven SUS-flagged packages (fastify, typebox, mongodb, p-retry, vitest, @biomejs/biome, @types/node) are legitimate (flag is only `too-new`) | Package Legitimacy Audit | Supply-chain risk; mitigated by one human-verify checkpoint |
| A2 | pnpm `minimumReleaseAge` may reject very fresh exact pins on some installs | Pitfall 6 | A clean CI install could fail; fix by waiting or per-package exemption |
| A3 | GitHub-hosted runners ship Compose v2 and GHCR publish works with `packages: write` once org settings allow it; package visibility may need a manual switch | Pattern 10 | CI image push fails until a human changes a setting |
| A4 | Renovate's npm manager updates `pnpm-lock.yaml` for pnpm 12 | Pattern 10 | Renovate PRs may not update the lockfile (the reason Renovate was chosen) |
| A5 | `webdav` `maxContentLength`/`entityDecoder.limit` options take effect at runtime | Pattern 8 | Weaker DoS bounds than expected; add own size checks via `stat` and `maxBytes` |
| A6 | Dockerfile `HEALTHCHECK` command works as written | Pattern 10 | Container reports unhealthy |
| A7 | Retry/timeout/concurrency defaults (2 slots, 4 retries, 15/60 s) are safe for mailbox.org | Pattern 8 | Throttling or lockout; rate limits are unpublished (D-09); keep conservative |
| A8 | Every OX behaviour (ETag shape/stability, `If-Match`, LOCK, MOVE-over-existing, versions/trash, case sensitivity, NFC/NFD, `Last, First` encoding, 411 on chunked, `Depth: infinity`) is unknown until the spike | OX Spike Design | Adapter error mapping and Phase 3/4 designs may need change |
| A9 | `docker/metadata-action` `type=sha` default format yields `sha-<short>` | Pattern 10 | Tag mismatch with D-21; check in the first CI run |

## Open Questions

1. **Does `read` return a Buffer or a stream?**
   - Known: ARCHITECTURE.md sketches `Readable`; Phase 4 downloads want streaming; retries and the concurrency slot are simpler with whole bodies; exceljs/mammoth need Buffers.
   - Unclear: Phase 4 size ceilings.
   - Recommendation: Phase 1 `read(p, {maxBytes}) => Buffer` (stat first, plus `maxContentLength`); add `readStream` additively in Phase 4. The planner confirms in the interface task.
2. **Spike timing versus adapter code.**
   - Recommendation: start the spike prep in Wave 1 and ask the user to run it as soon as convenient; plan Wave 4 to absorb findings. If the user cannot run it before the rest is done, STOR-01 is the only requirement left open.
3. **Where does the spike script live?**
   - D-07 says not a maintained repo script. Recommendation: commit it only under the phase directory as an unmaintained artefact (documents exactly what was probed), never under `src/` or `test/`. The planner may choose `tmp/` instead.
4. **mkdir strictness and `ensure` helpers.** Contract makes `mkdir` strict (existing is `conflict`). If Phase 3 needs idempotent folder creation it can wrap it.
5. **Is the `/ready` response body public?** It reveals Drive state to anyone who can reach it; acceptable for now, restrict at the gateway.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | everything | yes | v26.0.0 locally (CI: setup-node `26`; `node:26-slim` was v26.13.1) | none needed |
| npm | installing pnpm | yes | 11.12.1 | — |
| pnpm | package manager | no (not installed locally) | target 12.21.0 | `npm install -g pnpm@12.21.0` (or `npx pnpm@12.21.0`, used in research) |
| Docker | Compose stack, image build | yes | 29.9.3 | — |
| Docker Compose | `docker compose up --wait` | yes | v5.7.0 | — |
| `mongo:8.0`, `hacdias/webdav:v5`, `node:26-slim` images | stack, Dockerfile | yes (pulled) | mongod 8.0.38, webdav v5.17.3, node v26.13.1 | — |
| gh CLI | repo/CI inspection | yes | 2.93.0 | — |
| mailbox.org account + app password | OX spike | user-held | — | none: STOR-01 blocked without it (human checkpoint) |
| GitHub: Renovate app, GHCR package settings | D-21, D-23 | needs human action | — | CI works without; publishing/updates wait |

**Missing dependencies with no fallback:** a real mailbox.org account (user supplies at the checkpoint).
**Missing dependencies with fallback:** pnpm (install globally).
Repo facts: default branch `main`, public, Actions default workflow permissions are `read` (so the image job must declare `packages: write`). [VERIFIED: `gh api` 2026-11-21]

## Test Strategy (requirement to test map)

Framework: vitest 5.1.1 (`unit` and `integration` projects). Quick run: `pnpm test` (unit, no Docker). Full: `pnpm stack:up && pnpm test:integration`. All behaviour starts RED (D-01).

| Req | Behaviour | Type | File (proposed) |
|-----|-----------|------|-----------------|
| FND-01 | all config errors in one failure, no values echoed, `*_FILE`, interpolation | unit | `test/unit/config.test.ts` |
| FND-02 | `/health` ok with Mongo down; `/ready` 503 on Mongo down, 200 + `drive` state on Drive down | unit (fakes) + integration (closed port) | `test/unit/health.test.ts`, `test/integration/ready.test.ts` |
| FND-03 | canary absent from all captured logs across error paths | unit + integration | `test/unit/logging-canary.test.ts`, `test/integration/canary.test.ts` |
| DEV-01/02/03 | stack up, tests run, CI green | integration + CI | `docker-compose.yml`, `.github/workflows/ci.yml` |
| DEV-04 | fixtures synthetic | scrub grep (manual step) | `test/fixtures/ox/` |
| STOR-01 | matrix complete | doc review (human) | `docs/ox-webdav-compatibility.md` |
| STOR-02 | outside mount / write to read mount rejected; overlap validation | unit | `test/unit/mounts.test.ts` |
| STOR-03 | traversal corpus + seeded property test | unit | `test/unit/drive-path.test.ts` |
| STOR-04 | shared contract: stat, list, read, write, mkdir, move, delete | unit (memory) + integration (WebDAV) | `test/contract/storage-adapter.contract.ts` |
| STOR-05 | retry matrix, no retry 401/403, concurrency cap, Depth 0/1 only | unit (fake http server) | `test/unit/webdav-adapter.test.ts` |

Wave 0 gaps (all net new): package/tsconfig/Biome/vitest config, `test/` tree, contract suite, fake-server helper, stack files.

## Security Domain

`security_enforcement` is on, ASVS level 1. [VERIFIED: .planning/config.json:49]

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | partial | Only outbound Drive credentials this phase (app password via env/`*_FILE`); 401 never retried, cooldown circuit |
| V3 Session Management | no | No sessions |
| V4 Access Control | yes | Mount allow-list, `read`/`read-write` enforced in `MountView` and at runtime |
| V5 Input Validation | yes | `DrivePath` segment rules, NFKC check, Ajv config validation (`additionalProperties: false`) |
| V6 Cryptography | no | None hand-rolled; TLS to Drive via the client (`https:` required except loopback) |
| V7 Error handling and logging | yes | Serializer allow-list, `StorageError` without paths, canary CI test |
| V8 Data protection | yes | No bodies/queries/paths in logs, secrets never logged, `[set]`-style config logging |
| V12 Files and resources | yes | Traversal corpus, no deep PROPFIND, files-only delete, response size caps |
| V14 Configuration / supply chain | yes | Secrets only via env/`*_FILE`, lockfile + frozen installs, exact pins, Renovate, one human-verify on flagged packages |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal / mount escape (`..`, `%2e%2e`, NFKC dots, NUL, `\`) | Tampering, Elevation | Segment-array `DrivePath`, branded `ResolvedPath`, corpus + property test |
| PII/secret leakage via logs or errors (URLs, yaml excerpts, driver messages) | Information Disclosure | Serializers, error mapping, canary test |
| Credential lockout/hammering via retries on 401/403 | Denial of Service | No retry, cooldown circuit |
| Retry storm or deep PROPFIND against provider with unpublished limits | Denial of Service | Concurrency cap, bounded backoff, `Depth` 0/1 only, request-recording test |
| Oversized/hostile PROPFIND XML (entity expansion, huge bodies) | Denial of Service | `entityDecoder.limit`, `maxContentLength` [ASSUMED effective], own `maxBytes` |
| Accidental recursive folder delete | Tampering | File-only `delete` via stat check |
| Secrets committed to repo/image | Information Disclosure | `.gitignore` already blocks `.env*` and `config/*.yaml`; `.dockerignore`; env/`*_FILE` only |
| Spike credentials/personal data in fixtures | Information Disclosure | Env-only credentials, scrubbed fixtures, scrub grep, human review |
| Dependency compromise | Tampering | Exact pins, frozen lockfile, pnpm build blocking, Renovate release-age, human-verify gate |

## Sources

### Primary (HIGH confidence, executed this session)
- npm registry (`npm view`) for all versions and publish dates in Standard Stack; `gsd_run query package-legitimacy check`.
- Scratch project (pnpm 12.21.0, TS 7.0.2, vitest 5.1.1, Biome 2.6.8, Fastify 5.12.8, webdav 5.11.0, mongodb 7.9.1, p-retry 9.0.0, ajv 8.20.0, yaml 2.9.1): typecheck/emit, projects config, Biome rule, canary harness, config validation behaviours, webdav wire probes against a scripted node http server and hacdias/webdav v5.17.3, Compose stack, Docker multi-stage build, `pnpm audit`.
- Installed package sources and types: `p-retry/index.d.ts`, `webdav/dist/node/types.d.ts`, `fastify/docs/Reference/Server.md` (`logController`), Biome `configuration_schema.json` (nursery `noFloatingPromises`).
- GitHub API: latest releases of the Actions listed; repo default workflow permissions; repo visibility.
- In-repo files read: `01-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `STATE.md`, research `SUMMARY.md`/`ARCHITECTURE.md`/`PITFALLS.md`/`STACK.md`, `.gitignore`, `.planning/config.json`, `.claude/CLAUDE.md`.

### Secondary (MEDIUM, official docs)
- https://pnpm.io/supply-chain-security (minimumReleaseAge default 1440 min, `allowBuilds`, `strictDepBuilds`, `blockExoticSubdeps`).
- https://github.com/pnpm/action-setup/blob/v6.1.1/README.md (reads `packageManager`).
- https://docs.renovatebot.com/presets-config/ (`config:best-practices`).
- https://kb.mailbox.org/en/business/drive-article/webdav-for-linux/ (base URL, `if_match_bug 1`, `use_locks 0`; silent on limits/trash/versions).
- https://kb.mailbox.org/en/private/security-and-privacy/application-passwords-for-external-programs/ (app password types).

### Tertiary (LOW)
- Web searches for OX infostore WebDAV behaviour (versions, trash, LOCK, Depth) returned no OX documentation; nothing about OX behaviour is verified.

## Metadata

**Confidence breakdown:**
- Standard stack and toolchain: HIGH. Each pinned version was installed and exercised.
- Architecture and adapter/retry design: MEDIUM-HIGH. Verified against hacdias and a fake server; OX differences unknown.
- Logging/config pitfalls: HIGH. Reproduced with a prototype.
- CI/GHCR/Renovate details: MEDIUM. Action versions verified; workflow YAML and org settings not executed.
- OX behaviour and spike outcomes: LOW until the human run.

**Research date:** 2026-11-21
**Valid until:** about 2026-12-05 for toolchain versions (fast-moving: TS 7, pnpm 12, vitest 5 are weeks old); the OX matrix does not expire until mailbox.org changes its platform.
