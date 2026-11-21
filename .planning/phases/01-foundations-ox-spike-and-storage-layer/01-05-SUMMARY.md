---
phase: 01-foundations-ox-spike-and-storage-layer
plan: 05
subsystem: ci
tags: [github-actions, ghcr, renovate, docker, pnpm, readme]
requires:
  - phase: 01-11
    provides: "Compose stack and integration project that the integration job runs"
provides:
  - "CI workflow: check, integration and image jobs on every push to main and every pull request"
  - "GHCR image ghcr.io/<owner>/mailbox-org-drive-rest-api with tags :main and :sha-SHORT, published only from main"
  - "renovate.json (config:best-practices, grouped npm minor/patch, exceljs pinned, lockfile maintenance)"
  - "README '## Local development' quick start"
affects: [01-10, 01-12, 02, 03, 04]
actuals:
  tokens: 1133
  tasks: 3
  commits: 1
tech-stack:
  added: []
  patterns: [image name derived from GITHUB_REPOSITORY lowercased, login and push both gated on push to main, packages write only on the image job]
key-files:
  created:
    - .github/workflows/ci.yml
    - renovate.json
  modified:
    - README.md
key-decisions:
  - "Image name is derived from the repository context at run time; no owner is spelled out in the workflow, README or source"
  - "Fast-forwarded main with `git push origin <sha>:refs/heads/main` from the agent branch (main had no protection or rulesets, and the user authorised it); the local main worktree was left untouched"
  - "Renovate App install is recorded as pending (D-23 allows it); it needs an owner browser action that gh cannot perform"
requirements-completed: [DEV-03]
status: complete
duration: 2h (spanning the checkpoint)
completed: 2026-11-21
commits: 1
plan_head_before: bb8129d7e3251392fb7cee624f44ee52117e0c23
plan_head_after: c77b342de7a48704bcb870d36b2989e4df1d5895
---

# Phase 1 Plan 05: CI pipeline, GHCR publish, Renovate and README quick start Summary

**A green `main` run of `check`, `integration` and `image` now publishes `:main` and `:sha-SHORT` to GHCR, both fetchable anonymously; Renovate config is committed but the Renovate App install is still pending an owner action.**

## Tasks

| Task | Type | Result | Commit |
|------|------|--------|--------|
| 1. Pipeline, Renovate config, README quick start | tracer | Done; all CI commands passed locally | `c77b342` |
| 2. Push to main, GHCR access, Renovate install | checkpoint:human-action | Push, GHCR publish and anonymous visibility done by the agent via `gh`; Renovate App install not done | (no commit, GitHub state) |
| 3. Confirm published image and Renovate from outside | auto | Image checks pass; Renovate recorded pending | (no commit) |

## Task 2 detail (what was automatable)

- `ZioHimself` has ADMIN on `europeanresolve/mailbox-org-drive-rest-api`. `main` had no branch protection (404) and no rulesets, and Actions permissions are `allowed_actions: all`.
- Fast-forward push: `git push origin 9667d3b:refs/heads/main` moved `main` from `11de311` to `9667d3b` (52 commits, including this plan's `c77b342`). `c77b342` is an ancestor of `origin/main`.
- The first image push to GHCR succeeded with no "denied" or 403, so no org Packages setting had to change and no rerun was needed.
- The repository is public and the package is anonymously readable (below), so no manual visibility change was needed.
- Not done: installing the Renovate GitHub App. It is a browser install on the organisation and `gh` has no endpoint for it.

## Task 3 evidence

- Run: https://github.com/europeanresolve/mailbox-org-drive-rest-api/actions/runs/44928849712, conclusion `success`.
- Jobs: `check` 22 s, `integration` 36 s, `image` 36 s, all steps green, including `docker/login-action`, `docker/metadata-action` and `docker/build-push-action`.
- Anonymous pull check (token from `https://ghcr.io/token?scope=repository:europeanresolve/mailbox-org-drive-rest-api:pull`, no local docker login touched):
  - `:main` returns 200, digest `sha256:b01cb051e2894c8db6b83eb46be0b56b45cd52017a6f5e8f0edadc1a942718c8`
  - `:sha-9667d3b` returns 200, same digest
- `gh api orgs/.../packages/container/...` could not be read (the token lacks `read:packages`), so package visibility and repository link are inferred from the anonymous 200s, not read from settings.
- Renovate: `gh issue list --author app/renovate --state open` returns `[]` and there are no pull requests. **Renovate pending**, to be re-checked at phase verification.

## Open items

- **Renovate App install (owner action):** install https://github.com/apps/renovate for `europeanresolve/mailbox-org-drive-rest-api` only. Re-check at phase verification for the Dependency Dashboard issue.
- **Research assumption A4** (Renovate updates `pnpm-lock.yaml` correctly) is confirmed on its first PR; still open.
- **Package repository link:** confirm the package is linked to the repository in the package settings (could not read it with the current token scopes).

## Deviations from Plan

### Auto-fixed Issues

None - plan executed as written.

### Notes

- Checkpoint Task 2 was executed by the agent instead of the user, on the orchestrator's instruction, because the owner steps turned out to be automatable except the Renovate install. The "user replied done" criterion is therefore replaced by the agent's own verification above.
- The pre-commit ledger file `gsd-plan-head-before-01-05` was never written (Task 1 ran before the continuation); `plan_head_before` is `c77b342^`.

## Threat Flags

None. The workflow follows the plan's threat register: top-level `contents: read`, `packages: write` only on `image` (T-01-13); login and push gated on `push` to `main` (T-01-14); `config:best-practices` in `renovate.json` (T-01-15); `pnpm install --frozen-lockfile` everywhere (T-01-SC).

## Self-Check: PASSED

- FOUND: .github/workflows/ci.yml, renovate.json, README.md
- FOUND: c77b342 is an ancestor of HEAD and of origin/main
