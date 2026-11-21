---
phase: 01-foundations-ox-spike-and-storage-layer
plan: 06
subsystem: config
tags: [config, yaml, ajv, typebox, secrets, no-echo, startup, tdd, fnd-01]
requires:
  - phase: 01-03
    provides: "buildMounts(defs) and MountIssue codes for the semantic pass"
  - phase: 01-04
    provides: "PII-free logger options and buildApp({ logger: { level, stream } })"
provides:
  - "loadConfig(env): file, YAML, ${NAME}/NAME_FILE, PORT/LOG_LEVEL, Ajv 2020 and semantic pipeline; deeply frozen Config"
  - "ConfigError(issues) and ConfigIssue {code, at?, line?, col?}; issue codes file.*, yaml.*, env.*, schema.*, mount.*, storage.*"
  - "ConfigSchema (TypeBox, additionalProperties false at 7 levels) and the Config type"
  - "start({ env, logStream }): loads config first; main guard prints one fatal 'invalid configuration' line and exits 1"
  - "config/config.example.yaml deployer example"
affects: [01-08, 01-09, 01-10, 01-12]
tech-stack:
  added: []
  patterns: [issues-as-data pipeline with exact-duplicate collapse, interpolation on parsed values only, document-order sorting via yaml node ranges, one-line failure messages so TAP reports stay parseable]
key-files:
  created:
    - src/config/schema.ts
    - src/config/load.ts
    - config/config.example.yaml
    - test/unit/config.test.ts
    - test/fixtures/config/invalid-many.yaml
    - test/fixtures/config/valid.yaml
  modified:
    - src/server.ts
key-decisions:
  - "A missing or extra key is named in `at` by appending it to the instance path (schema.required at /mongo, schema.additionalProperties at /mounts/Bad_Name); ConfigIssue has no other field to name it"
  - "env.* issues name the variable in `at` (WEBDAV_APP_PASSWORD, PORT, LOG_LEVEL); env.INVALID_PLACEHOLDER carries the JSON pointer"
  - "server.port and server.logLevel are individually optional so a partial server block, or PORT alone with no server block, works and defaults apply"
  - "Missing-key issues sort at the end of their parent object; exact duplicate issues (same code, location) collapse to one"
  - "Empty PORT or LOG_LEVEL (set but not valid) is an issue, not 'unset'"
requirements-completed: [FND-01]
status: complete
duration: 11min
completed: 2026-11-21
commits: 6
plan_head_before: bb8129d7e3251392fb7cee624f44ee52117e0c23
plan_head_after: c915776bda5ebabaf6b123e7a4689fd06733cedb
actuals:
  tokens: 8200
  tasks: 3
  commits: 6
---

# Phase 1 Plan 06: Fail-fast config loader Summary

**YAML config loader that reports every error in one structured startup failure (file, YAML, env, schema, semantic), resolves `${NAME}` from env or `NAME_FILE`, and never echoes a config value.**

`commits: 6` counts this plan's own `(01-06)` commits. `git rev-list` from the recorded base gives 14 because plans 01-05 and 01-07 committed on the same branch in parallel.

## Tasks

| Task | Type | RED | GREEN |
|------|------|-----|-------|
| 1. A bad config file gives one startup failure from the compiled server | tracer | `c5fc9b5` test | `1d6d8b9` feat |
| 2. Every config error class, secret sources and the no-echo guarantee | auto, tdd | `0377a12` test | `04ca346` feat |
| 3. Deployer example config and the valid startup path | auto, tdd | `1335020` test | `c915776` feat |

No REFACTOR commit was needed.

## TDD evidence

All three RED runs were classified with `gsd_run check tdd-red-evidence` and returned `RED_EVIDENCE_OK` (`target_test_failed`) before GREEN started.

- **Task 1 RED:** `load.ts` was a stub returning `{}`. 5 of 5 tests failed with "expected loadConfig to throw a ConfigError". Target: "reports an insecure WebDAV URL".
- **Task 2 RED:** 37 failures, 25 already passing. The failures were the missing pieces the plan assigns to this task: raw ENOENT instead of `file.UNREADABLE`, unresolved `${...}`, no `env.*` issues, unsorted schema issues, unfrozen result. The passing rows are the schema, mount and URL cases the Task 1 minimal pipeline already covered; they stay as regression guards. Target: "a missing file gives only file.UNREADABLE at the path".
- **Task 3 RED:** 1 failure (example config absent, `file.UNREADABLE`). The `start()` valid-path test passes at RED because `start()` was built in Task 1 (the plan puts it there); it stays as a D-19 regression guard. Target: "loads cleanly once its environment variables are set".
- **GREEN:** `pnpm test` 163/163 across the repo (57 in `config.test.ts`); `pnpm typecheck` and `pnpm lint` are clean on the whole repo.

**Tracer feedback gate:** auto-advance is on and the task has no `gate="blocking-human"`. The compiled-server `<verify>` ran green end to end before Task 2: `pnpm build`, then `CONFIG_FILE=test/fixtures/config/invalid-many.yaml node dist/server.js` exits 1 with exactly one stderr line, containing 4 issues and no `password` or `uri` text. It was re-run after Task 3 with the same result. A valid config under `dist/server.js` with `PORT=0` logs `configuration loaded` with mount names and modes only.

## TDD Gate Compliance

Each of the three RED (`test(01-06)`) commits precedes its GREEN (`feat(01-06)`) commit and the GREEN descends from the RED. No gate violations.

## What was built

- `schema.ts`: TypeBox `ConfigSchema` with `additionalProperties: false` on every object (root, server, mongo, storage, webdav, mount entry, mounts record). The `mounts` Record options are what reject a bad mount name (Pitfall 3). `Config` is the resolved, readonly type.
- `load.ts`: stages run in order and collect issues. File read failure gives only `file.UNREADABLE`; YAML errors give `yaml.CODE` with line and col (never `.message`) and stop the run. Then `${NAME}` interpolation over parsed string values, `PORT`/`LOG_LEVEL` overrides, Ajv 2020 (`allErrors`, `strict`), and a semantic pass (`storage.INSECURE_URL`/`INVALID_URL`, then `buildMounts`). Result order is file, yaml, env, schema, semantic; schema and semantic issues are sorted by position in the document using the YAML node ranges, so two runs print the same output.
- Placeholder handling: `NAME` from env or `NAME_FILE` (one trailing `\r?\n` trimmed). Both-set, missing, unreadable file and malformed placeholder each give one issue naming the variable or pointer, and that field gets no second schema or semantic issue.
- `server.ts`: `start({ env, logStream })` calls `loadConfig` before building the app, logs `configuration loaded` with `{port, logLevel, mounts: [{name, mode}]}` only, and the main guard logs one `fatal` `invalid configuration` line (or `startup failed` with the error type only) via a bootstrap pino on stderr, setting `exitCode = 1` without listening.
- `config/config.example.yaml`: placeholders for WebDAV URL, credentials and Mongo URI, a commented `server` block, two synthetic mounts. Tracked by git; `config/config.yaml` stays ignored.

## Deviations from Plan

### Judgement calls

**1. [Interpretation] Where a missing or extra key is named**
- **Issue:** The plan says `schema.required at ""` "naming mongo", but `ConfigIssue` has no field besides `at` to name it.
- **Fix:** `at` is the instance path plus the property (`/mongo`, `/extra`, `/mounts/Bad_Name`), JSON-pointer escaped. Tests assert those values.

**2. [Rule 1 - Bug] `server.port` and `server.logLevel` made optional**
- **Found during:** Task 2 GREEN
- **Issue:** The plan lists them as plain fields inside the optional `server` block. That would make `server: {port: 4000}` fail with `schema.required` for `logLevel` and would make a `PORT` override with no `server` block fail, although the defaults exist for exactly these cases.
- **Fix:** Both are `Type.Optional`; defaults are filled in by `loadConfig`.
- **Files modified:** `src/config/schema.ts`
- **Commit:** `04ca346`

**3. [Rule 2 - Missing critical] Exact duplicate issues collapse**
- **Found during:** Task 2 probe
- **Issue:** `yaml` reports `BAD_INDENT` twice at one position, and one variable used in two fields would give two identical `env.*` issues.
- **Fix:** the issue collector drops exact duplicates (same code and location) while keeping first-seen order.
- **Commit:** `04ca346`

### Process notes

- The Task 2 RED commit was first made before the classifier had approved it: the first record came back `INVALID_RED` (`invalid_record`) because vitest's multi-line `toEqual` diffs break TAP. I noticed in the same step, replaced `toEqual` with a one-line-message helper (`eq`), re-ran, got `RED_EVIDENCE_OK`, and amended the commit (`d021eb3` became `0377a12`) before any GREEN code existed. The final RED commit is the validated one.
- The `Co-Authored-By` trailer on these commits names this session's model, `Claude Sonnet 5.5`; earlier plans use a different model name.

## Environment notes

- Tests that call `start()` bind `0.0.0.0`, and Fastify then logs addresses through `os.networkInterfaces()`, which fails with `uv_interface_addresses` EPERM inside the Cursor command sandbox (the test then times out). Run them with the sandbox off. CI and a normal shell are unaffected.
- At the start of this plan `pnpm lint` failed on two formatting errors in untracked files of plans 01-05/01-07 (`memory-adapter.ts`, the contract test). Those were fixed by their own commits; nothing in this plan touched them. Each commit here used `git commit --only` with explicit paths so the other plans' work stayed out.
- `git status` still shows an uncommitted `README.md` change that predates this plan and is not part of it.

## Auth gates

None.

## Known Stubs

None.

## Threat Flags

None. T-01-16 to T-01-19 are covered by tests: the canary never appears in issues or messages across 9 invalid-config cases (secret value, env value, malformed line, bad PORT, bad LOG_LEVEL, malformed placeholder, bad URL, bad mode, unreadable `_FILE`); env content stays a literal string (`a: [b, {c`); `storage.INSECURE_URL` and `mount.OVERLAP`/`mount.AT_ROOT` land in the same failure. The one value that does appear is the `CONFIG_FILE` path in `file.UNREADABLE`, which is a deployer-chosen location, not a secret.

## Self-Check: PASSED

- FOUND: src/config/schema.ts, src/config/load.ts, src/server.ts, config/config.example.yaml, test/unit/config.test.ts, test/fixtures/config/invalid-many.yaml, test/fixtures/config/valid.yaml
- FOUND commits: c5fc9b5, 1d6d8b9, 0377a12, 04ca346, 1335020, c915776 (all ancestors of HEAD)
- `git check-ignore config/config.example.yaml` exits 1; `config/config.yaml` exits 0
