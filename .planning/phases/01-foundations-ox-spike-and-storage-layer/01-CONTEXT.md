# Phase 1: Foundations, OX Spike and Storage Layer - Context

**Gathered:** 2026-11-21
**Status:** Ready for planning

<domain>
## Phase Boundary

A developer can start the local stack (MongoDB + local WebDAV server), run the full test suite green in CI on every push to `main`, and rely on a path-safe, retry-aware `StorageAdapter` whose behaviour against mailbox.org (OX App Suite) WebDAV is documented in a compatibility matrix. Also delivers fail-fast YAML config, `/health` + `/ready`, and PII-free structured logs with a canary test.

Requirements: FND-01, FND-02, FND-03, DEV-01, DEV-02, DEV-03, DEV-04, STOR-01, STOR-02, STOR-03, STOR-04, STOR-05.

Not in this phase: collections, MongoDB index bootstrap, auth policies (Phase 2); mirror worker and container roles (Phase 3); sheets/docs/files endpoints (Phase 4). `/ready` needs only a minimal Mongo ping here.

</domain>

<decisions>
## Implementation Decisions

### Project-wide (carried forward)
- **D-01:** TDD for all behaviour (RED → GREEN → REFACTOR); `workflow.tdd_mode` on.
- **D-02:** Trunk-based development on `main`; no long-lived branches; `main` always green.
- **D-03:** Integration tests run only against the local Docker stack, never a real Drive; all fixtures synthetic.

### OX WebDAV spike (STOR-01)
- **D-04:** Probe the user's own relatively fresh mailbox.org account (not a dedicated service account; holds no sensitive data).
- **D-05:** All probing happens inside one throwaway folder (e.g. `probe-<date>/`) that the spike deletes afterwards. Nothing outside it is read or written.
- **D-06:** Credentials come only from the user's shell environment (an app password if mailbox.org offers one). They are never written to disk, logs, fixtures or the repo.
- **D-07:** One-off manual spike, not a maintained repo script. Only the written compatibility matrix and synthetic fixtures (e.g. recorded PROPFIND/response XML with names and hosts anonymised) are kept.
- **D-08:** Trash and versions: probe over WebDAV, plus a short checklist the user follows in the OX web UI to confirm trash/version effects of overwrite and delete. The OX HTTP API is not probed in this phase.
- **D-09:** Don't contact mailbox.org support about rate limits now. The adapter uses conservative concurrency and backoff; revisit before production (stays in STATE blockers).
- **D-10:** The spike runs with the user present (it needs their credentials and web UI checks), so the plan must mark it as a human-action checkpoint, not an autonomous task.

### Toolchain
- **D-11:** pnpm as package manager. — **Reversibility:** costly — lockfile, CI cache steps, Dockerfile and docs all assume pnpm.
- **D-12:** TypeScript 7 (native compiler) with Biome for lint and format; `tsc --noEmit` for typecheck. — **Reversibility:** costly — switching to ESLint means a new lint config and rule review across the codebase.
- **D-13:** Compile to `dist/` with `tsc`; the image runs compiled JS. No Node type-stripping at runtime.
- **D-14:** vitest as test runner (unit + integration against Compose).
- **D-15:** Node 26 only, both locally and in CI (no Node 24 matrix).

### Config shape (FND-01, STOR-02)
- **D-16:** One `config.yaml` file, validated against a JSON Schema at startup; all errors listed in one failure. — **Reversibility:** one-way — the config file format is a published contract for deployers; changing it breaks existing deployments.
- **D-17:** Environment variables (and `*_FILE` variants) carry only secrets and deployment values (Mongo URI, WebDAV URL/user/password, port, log level). Structure (mounts, later collections) lives only in the file. The YAML references secrets with `${VAR}` placeholders.
- **D-18:** JSON Schemas (for later collections) may be `$ref`'d from sibling files next to `config.yaml`; no config directory merging.
- **D-19:** Mounts are addressed by name in API paths (e.g. `/files/{mount}/...`). Real Drive folder paths (such as `Userstore/Last, First`) are never exposed to clients or logs. — **Reversibility:** one-way — URL shape is part of the public API contract.

### CI & delivery (DEV-03)
- **D-20:** GitHub Actions. Every push to `main` runs Biome, typecheck, unit tests, integration tests (Compose services) and the image build; any failure fails the pipeline.
- **D-21:** Publish the image to GHCR (`ghcr.io/europeanresolve/mailbox-org-drive-rest-api`) on green `main`, tagged `:sha-<short>` and a moving `:main`. Semver tags come later with releases.
- **D-22:** No FerretDB job for now; code stays within a portable MongoDB subset (single-document atomic ops, no transactions or change streams).
- **D-23:** Renovate (free hosted app for public repos) for dependency updates: grouped updates, pnpm/Dockerfile/GitHub Actions managers, `exceljs` pinned exactly. Chosen over Dependabot for more reliable support of new pnpm lockfile versions.

### Claude's Discretion
- Exact layout of the probe folder, the probe steps, and the matrix document format.
- Local dev WebDAV server choice (research recommends `hacdias/webdav:v5`), Compose file details, and Dockerfile base (`node:26-slim` recommended).
- Retry/backoff parameters and default concurrency cap (research suggests 2–4).
- Internal module layout (`DrivePath`/`PathGuard`, adapter contract suite structure).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project scope and decisions
- `.planning/PROJECT.md` — locked decisions, constraints (TDD, trunk-based, synthetic data, mailbox.org terms)
- `.planning/REQUIREMENTS.md` — FND-01..03, DEV-01..04, STOR-01..05 wording
- `.planning/ROADMAP.md` §Phase 1 — goal and success criteria
- `PROJECT-BRIEF.md` — original brief; §Constraints and risks covers OX WebDAV, versioning/trash and terms

### Research
- `.planning/research/SUMMARY.md` — synthesis and Phase 1 deliverables list
- `.planning/research/STACK.md` — versions, `webdav` client quirks (ETag quote stripping, no retry, global patcher), dev WebDAV server test results (If-Match not enforced)
- `.planning/research/ARCHITECTURE.md` — component boundaries, branded `ResolvedPath`, adapter contract suite
- `.planning/research/PITFALLS.md` — OX WebDAV pitfalls, path encoding, retry classification (no retry on 401/403), log PII leaks

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None. Greenfield repo (README, PROJECT-BRIEF, LICENSE, `.gitignore` only).

### Established Patterns
- `.gitignore` already present (Node-oriented); EUPL-1.2 licence.

### Integration Points
- GitHub repo `europeanresolve/mailbox-org-drive-rest-api`, default branch `main`.

</code_context>

<specifics>
## Specific Ideas

- The spike is a one-off. Its value is the matrix plus anonymised fixtures, which feed the adapter contract suite and later the mirror (Phase 3) and cache (Phase 4) designs.
- The user's mailbox.org account is personal, so the scoped-folder and credentials-from-env rules are hard constraints.

</specifics>

<deferred>
## Deferred Ideas

- Asking mailbox.org support for WebDAV rate limits: before production (tracked in STATE blockers).
- Probing the OX HTTP API (hard delete, delete versions): v2.0 erasure work.
- FerretDB CI job: revisit only if a fully OSI-licensed stack becomes a requirement.
- Node 24 support: not planned.

</deferred>

---

*Phase: 01-foundations-ox-spike-and-storage-layer*
*Context gathered: 2026-11-21*
