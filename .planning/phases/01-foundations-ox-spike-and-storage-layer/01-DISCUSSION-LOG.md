# Phase 1: Foundations, OX Spike and Storage Layer - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-21
**Phase:** 1-Foundations, OX Spike and Storage Layer
**Areas discussed:** OX spike logistics, Toolchain, Config shape, CI & delivery

---

## OX spike logistics

| Question | Options | Selected |
|----------|---------|----------|
| Account to probe | Dedicated test account / Sub-folder of NGO account / Not available yet | Other: user's own fresh account, no sensitive data |
| Probe form | Repo script, opt-in / One-off manual spike | One-off manual spike |
| Who asks support about limits | I'll ask / Skip for now | Skip for now |
| Trash/versions probing | WebDAV + check web UI / Also try OX HTTP API / WebDAV only | WebDAV + check web UI |
| Scope on personal account | Yes, scoped folder / Let me explain | Yes, scoped folder |

**Notes:** Probes are confined to a throwaway folder that is deleted afterwards, and credentials come only from the shell environment.

---

## Toolchain

| Question | Options | Selected |
|----------|---------|----------|
| Package manager | pnpm / npm | pnpm |
| TypeScript + lint | TS 7 + Biome / TS 5.x/6 + ESLint | TS 7 + Biome |
| Run mode | Build to dist/ / Node type-stripping | Build to dist/ |
| Node versions | 26 target, 24 in CI / 26 only | 26 only |

---

## Config shape

| Question | Options | Selected |
|----------|---------|----------|
| File format | YAML / JSON / TOML | YAML |
| Env vars | Secrets + infra only / Any key overridable | Secrets + infra only |
| Layout | Single file / Config directory | Single file |
| Mount addressing | By mount name / You decide | By mount name |

---

## CI & delivery

| Question | Options | Selected |
|----------|---------|----------|
| CI + registry | GH Actions + GHCR / GH Actions, build only | GH Actions + GHCR |
| Image tags | sha + main / sha only | sha + main |
| FerretDB | Not now / Non-blocking / Blocking | Not now |
| Dependency updates | Renovate / Dependabot / None | Other: "whichever is free and supports our stack". Claude picked Renovate (both free for public repos; Renovate's support for new pnpm lockfile versions is more reliable) |

---

## Claude's Discretion

- Probe folder layout, probe steps, and matrix format
- Dev WebDAV server, Compose details, and Dockerfile base
- Retry/backoff parameters and concurrency cap
- Internal module layout

## Deferred Ideas

- Contact mailbox.org support about limits (before production)
- OX HTTP API probing (v2.0 erasure)
- FerretDB CI job
- Node 24 support
