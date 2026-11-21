# Walking Skeleton — mailbox-org-drive-rest-api

**Phase:** 1
**Generated:** 2026-11-21

## Phase User Story

**As a** developer building on this service, **I want to** start the local stack with one command, run the full test suite green in CI, and rely on a configurable, path-safe, retry-aware storage layer, **so that** I can build the website-forms features on documented mailbox.org WebDAV behaviour without touching a real Drive or leaking secrets and personal data into logs.

Source: ROADMAP Phase 1 Goal and success criteria 1-5.

## Capability Proven End-to-End

A developer runs `pnpm stack:up` and the test suite. A real HTTP `GET /health` against the built container image answers 200. The integration suite writes and reads back one MongoDB document and one WebDAV file on the local stack. CI runs the same pipeline on every push to `main`.

This is a backend-only API, so the skeleton's "one real UI interaction" is one real HTTP request against the running service (plan 01-01, Task 2). The MongoDB and WebDAV round trips are plan 01-11.

## Architectural Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Runtime and language | Node.js 26 only (D-15), TypeScript 7.0.2 native `tsc`, ESM, `erasableSyntaxOnly`, `.ts` import extensions rewritten on emit | Locked stack; the image runs compiled `dist/` only (D-13) |
| Framework | Fastify 5.12.8 behind `buildApp(options)` (factory, no listen) and `start(options)` (composition root in `src/server.ts`) | `inject()` tests without a socket; one place wires config, Mongo, storage and the app |
| Configuration | One `config.yaml` validated by a TypeBox-built JSON Schema with Ajv 2020 (`allErrors`, `strict`, `additionalProperties: false`); `${NAME}` placeholders from env or `NAME_FILE`; `PORT`/`LOG_LEVEL` overrides; all errors in one failure, no values echoed | D-16..D-18; the deployer contract (one-way, settled) |
| Data layer: records | MongoDB 8.0 through the official driver 7.9.1, lazy connect, portable subset (D-22) | System of record from Phase 2; Phase 1 sends only `ping` |
| Data layer: Drive | `StorageAdapter` port (stat, list, read as Buffer with `maxBytes`, write, mkdir, move, delete) with `WebDavAdapter` (`webdav` 5.11.0, p-limit, p-retry) and `MemoryAdapter`, both held to one contract suite | Backend swap without touching callers; contract asserts `StorageError` kinds, never raw statuses |
| Path model | Segment-array paths, branded `ResolvedPath` created only by `Mounts`; mounts addressed by name; real Drive paths never in URLs, errors or logs | STOR-02/03, D-19 (one-way, settled) |
| Errors | `StorageError(kind, op, status)` with no cause and no path; HTTP errors as `application/problem+json` `{type, title, status}` | No personal data leaks through library errors |
| Logging | Fastify's pino with allow-list serializers, one `request` line per request (route template, generated id, status, ms), `logController` request logging off, canary-tested | FND-03; records are personal data from Phase 2 |
| Health | `/health` liveness with no dependencies; `/ready` = Mongo ping plus cached single-flight Drive state (never blocks, never fails on Drive) | FND-02 |
| Auth | None inbound in Phase 1 (API keys and default-deny arrive in Phase 2); outbound Drive app password via env or `*_FILE` only | Scope; secrets never in the repo |
| Testing | vitest 5 projects: `unit` (no Docker, includes the in-process fake WebDAV server) and `integration` (Compose stack, per-run `it-<uuid>` db and `/run-<uuid>/` folder, loopback-only guard); shared `test/contract/` suite; TDD RED then GREEN commits | D-01, D-03, D-14 |
| Local stack | Docker Compose: `mongo:8.0` + `hacdias/webdav:v5`, loopback ports, tmpfs (plan 01-11) | DEV-01; hacdias chosen by research |
| Deployment target | One `node:26-slim` image (non-root `node` user) on GHCR `ghcr.io/<owner>/mailbox-org-drive-rest-api` (name derived in CI from the repository context) tagged `:main` and `:sha-<short>` | D-21; roles `api`/`worker`/`all` arrive in Phase 3 |
| Delivery | GitHub Actions on every push to `main` and on PRs (Biome, typecheck, unit, integration, image); Renovate `config:best-practices`; trunk-based `main` | D-02, D-20, D-23 |
| Toolchain | pnpm 12.21.0 (exact pins, frozen lockfile), Biome 2.6.8 with `noFloatingPromises` as error | D-11, D-12 (both costly to reverse) |
| Directory layout | `src/{config,http,db,storage}`, `test/{unit,integration,contract,helpers,fixtures}`, `config/config.example.yaml`, `dev/webdav.yml`, `docs/` | `test/` mirrors `src/`; `tsconfig.build.json` emits only `src` |

## Stack Touched in Phase 1

- [ ] Project scaffold (framework, build, lint, test runner): plan 01-01; local stack and integration project: plan 01-11
- [ ] Routing, at least one real route: `GET /health` (01-01), `GET /ready` (01-09)
- [ ] Database, at least one real read AND one real write: MongoDB insert and find in the integration smoke test (01-11), Mongo ping in `/ready` (01-09); Drive write and read through the shared contract on Compose WebDAV (01-07, 01-08)
- [ ] UI, at least one interaction wired to the API: backend-only, so one real HTTP request to the running container image (01-01)
- [ ] Deployment: `pnpm stack:up` (01-11) plus the container image locally (01-01); image published to GHCR from green `main` (01-05)

## Out of Scope (Deferred to Later Slices)

- Collections, CRUD, record validation, MongoDB index bootstrap, OpenAPI `/docs` (Phase 2)
- API keys, default-deny policies, CORS, rate limiting, honeypot, CAPTCHA, idempotency, Kong reference config (Phase 2)
- Mirror worker, leases, container roles `api`/`worker`/`all` (Phase 3)
- Sheets, documents, file downloads, `readStream`, the ETag cache (Phase 4)
- OX HTTP API probing, GDPR erasure (v2.0); FerretDB CI job; Node 24 support (CONTEXT deferred ideas)
- Passive Drive-health tracking, caller `AbortSignal` on adapter calls, a `--config` CLI flag, pino `redact` (not needed: no headers are serialised)

## Subsequent Slice Plan

Each later phase adds one vertical slice on top of this skeleton without altering its architectural decisions:

- Phase 2: a website form POST creates a validated record behind default-deny access, and API-key holders manage records
- Phase 3: staff open an always-current `.xlsx` per collection in their Drive, written by a single background writer
- Phase 4: API consumers read Drive-edited sheets, `.docx` documents and files from an ETag-validated cache
