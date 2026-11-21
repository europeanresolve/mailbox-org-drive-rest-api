---
phase: 01-foundations-ox-spike-and-storage-layer
plan: 03
subsystem: storage
tags: [path-safety, mounts, traversal, unicode-nfkc, tdd, d-19]
requires:
  - phase: 01-01
    provides: "pnpm/TS7/vitest/biome scaffold, relative .ts import style"
provides:
  - "StorageError(kind, op, status?) and the 11-kind StorageErrorKind taxonomy"
  - "parseRelativePath / parseRootPath: segment-array path model, NFC output, raw and NFKC checks"
  - "buildMounts(defs) with MountIssue codes mount.INVALID_NAME / INVALID_PATH / AT_ROOT / OVERLAP"
  - "Mounts (names, get, resolve) and branded ResolvedPath (mount, segments, ref, toString, toJSON)"
affects: [01-05, 01-06, 01-07, 01-08, 01-09, 01-12]
tech-stack:
  added: []
  patterns: [segment arrays instead of path strings, module-private mint token for a branded type, issues-as-data config validation, inline seeded PRNG property test]
key-files:
  created:
    - src/storage/errors.ts
    - src/storage/drive-path.ts
    - src/storage/mounts.ts
    - test/unit/drive-path.test.ts
    - test/unit/mounts.test.ts
  modified: []
key-decisions:
  - "ResolvedPath also implements util.inspect.custom so console.log of one prints the mount name and ref only, not segments (D-19)"
  - "Config-validation issue order: per-mount issues (name, root) in config order first, then one OVERLAP per offending pair (i<j)"
  - "AT_ROOT is any root with zero segments after the leading slash (/ and //); every other parseRootPath failure is INVALID_PATH"
  - "Overlap and equality are case-sensitive on NFC segments (flagged assumption, plan 01-12 revisits after the spike)"
requirements-completed: [STOR-03]
requirements-partial: [STOR-02]
status: complete
duration: 4min
completed: 2026-11-21
commits: 6
plan_head_before: df04f1df5458106cf553515b6408943d5ec0eca7
plan_head_after: 7ec2cdf94b1456eaff371cfc62abc614e1ed77cc
actuals:
  tokens: 4275
  tasks: 3
  commits: 6
---

# Phase 1 Plan 03: Path safety Summary

**Segment-array `DrivePath` rules, an allow-listed `Mounts` registry and a branded `ResolvedPath` that cannot escape its mount, proven by a 29-row traversal corpus and a 2000-input seeded property test.**

## Tasks

| Task | Type | RED | GREEN |
|------|------|-----|-------|
| 1. Resolve one path, reject one traversal | tracer | `13ec692` test | `5107e28` feat |
| 2. Traversal corpus + seeded property test | auto, tdd | `36b4352` test | `2aabbc6` feat |
| 3. Mount allow-list validation | auto, tdd | `4be226a` test | `7ec2cdf` feat |

No REFACTOR commit was needed.

## TDD evidence (RED runs, all on assertions, none on imports)

- **Task 1 RED:** `drive-path.ts` and `mounts.ts` were stubs exporting the final names (`StorageError` was already final). 5 of 5 tests failed on assertions (`buildMounts` stub returned `ok:false`, so every test failed with "expected buildMounts to succeed" or `toBeInstanceOf(StorageError)`).
- **Task 2 RED (characterisation against the Task 1 minimal `checkSegment`):** 14 of 31 failed: backslash, backslash traversal, NUL, fullwidth dots, one-dot leaders, two-dot leader, small-form dots, fullwidth solidus, tab, newline, DEL, C1 control, 256-byte segment, and the property test, which reported counter-examples such as `"／／/e/2／%"`, `".a\u0000\\%"` and `"\\"`. The 17 rows that already passed (`..`, `a/../b`, `//`, `/etc`, `a/`, literal `%2e%2e`, NFD/NFC equality and so on) are rows the minimal rule set was designed to cover.
- **Task 3 RED:** 9 of 20 failed (AT_ROOT, INVALID_PATH x2, OVERLAP x4 incl. NFD/NFC, issue ordering, no-path-in-issue). INVALID_NAME and the 32-character boundary already passed from the tracer.
- **GREEN:** `pnpm test` is 65/65 across the repo (51 in this plan's two files); `pnpm typecheck` and `pnpm lint` are clean on the whole repo.

**Tracer feedback gate:** auto-advance is on; `<verify>` re-ran green end to end (5/5) before expansion. The task has no `gate="blocking-human"`.

## What was built

- `errors.ts`: `StorageError` with `kind`, `op`, optional `status`; message is exactly `${op}: ${kind}`, no cause, never a path.
- `drive-path.ts`: `checkSegment` rejects, on both the raw and the NFKC form, empty, `.`, `..`, `/`, `\` and U+0000-001F / U+007F-009F; rejects NFC segments over 255 UTF-8 bytes; returns NFC; never URL-decodes (`%2e%2e` stays a file name). `parseRelativePath("")` is `[]`; `parseRootPath` needs a leading `/`, allows one trailing `/`, rejects the Drive root.
- `mounts.ts`: `buildMounts` returns every issue (never just the first). `Mounts.resolve` prepends the root, asserts the root prefix element by element, and mints a `ResolvedPath` with a module-private `Symbol` token (constructing one elsewhere throws). `toString` is `mount:NAME ref:8hex`, `toJSON` is `{mount, ref}`, and `util.inspect` uses `toString`.

## Deviations from Plan

### Auto-fixed / judgement calls

**1. [Rule 2 - Missing critical] `util.inspect.custom` on `ResolvedPath`**
- **Found during:** Task 1 GREEN
- **Issue:** The plan covers `toString` and `toJSON`, but `console.log(resolved)` / pino object logging would still print `segments` through default inspection, which contradicts D-19 and T-01-09.
- **Fix:** Added `[inspect.custom]() { return this.toString(); }`.
- **Files modified:** src/storage/mounts.ts
- **Commit:** `5107e28`

**2. [Test design] Property test checks more than the plan lists**
- **Issue:** Checking only "no `''`, `.`, `..`, NFC" cannot produce a counter-example against the Task 1 minimal rule (the plan expects the RED run to report one).
- **Fix:** The property additionally asserts that every accepted segment has no `/`, `\` or control character and is not a dot segment after NFKC folding. This is a strictly stronger invariant than the plan states.
- **Files modified:** test/unit/drive-path.test.ts
- **Commit:** `36b4352`

**3. [Tooling] No control-character regex**
- Biome `noControlCharactersInRegex` rejects `/[\u0000-\u001f]/`; both `drive-path.ts` and the property test use a code-point loop instead.

**4. [Scope] STOR-02 not marked complete**
- The plan's success criteria say the "write to a `read` mount" half of STOR-02 lands in plan 01-07 (MountView). Only STOR-03 was marked complete in REQUIREMENTS.md; STOR-02 stays pending and should be closed by 01-07.

### Execution environment notes (not plan deviations)

- Commits landed on branch `ZioHimself/snook` (the linked worktree's branch; `main` is checked out in the primary clone). No commit touched `main`.
- The prompt said sequential mode, but plans 01-04 and 01-11 committed to the same branch and working tree while this plan ran. Every 01-03 commit used `git commit --only <paths>` with explicit paths so no foreign file was staged. A raw `git rev-list --count plan_head_before..HEAD` would count 13 because of the interleaved commits; `commits: 6` is measured with `git log --grep='(01-03)'` and matches the six hashes above.
- The first full `pnpm typecheck` / `pnpm lint` run during Task 1 failed on files owned by plan 01-04 (in-progress `src/app.ts` work); checks were scoped to this plan's files at that point and were green repo-wide by Task 3.
- The prompt references `CLAUDE.md` and the commit trailer: `.claude/CLAUDE.md` was read; it holds no commit-message rule, so the trailer block follows the two lines used by the earlier phase 01 commits (`Co-Authored-By: Claude Opus 5.5 ...` and `Co-authored-by: Cursor ...`) after `Refs: #2`.
- `context-mode` hooks blocked the `Read` tool for the plan file; it was read through `ctx_execute` instead.

## Known Stubs

None. The RED-phase stubs in `drive-path.ts` and `mounts.ts` were replaced in the same plan.

## Threat Flags

None. No new network endpoint, auth path or file access; this plan is pure in-memory path logic. T-01-08 (traversal) and T-01-09 (disclosure) are mitigated as planned; T-01-SC accepted (no packages added, PRNG inlined).

## Self-Check: PASSED

- FOUND: src/storage/errors.ts, src/storage/drive-path.ts, src/storage/mounts.ts, test/unit/drive-path.test.ts, test/unit/mounts.test.ts
- FOUND commits: 13ec692, 5107e28, 36b4352, 2aabbc6, 4be226a, 7ec2cdf
- `grep -c 'export class StorageError' src/storage/errors.ts` prints 1
- RED (`test(01-03)`) precedes GREEN (`feat(01-03)`) for all three tasks
