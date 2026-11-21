---
phase: 01-foundations-ox-spike-and-storage-layer
plan: 07
subsystem: storage
tags: [storage-adapter, memory-adapter, contract-suite, mount-view, read-only-mount, tdd]
requires:
  - phase: 01-03
    provides: "StorageError taxonomy, Mounts.resolve, branded ResolvedPath"
provides:
  - "StorageAdapter port, StatEntry, ReadOptions, DEFAULT_MAX_READ_BYTES (25 MiB)"
  - "MemoryAdapter that mimics the WebDAV semantics (files-only delete, strict mkdir, segment-compared move)"
  - "storageAdapterContract(name, setup) and ContractSetup: one shared suite, 33 cases, asserts on StorageError.kind only"
  - "openMount / MountView with ReadableMount and WritableMount; write methods on a read mount reject read-only-mount"
affects: [01-08, 01-09, 02, 03, 04]
actuals:
  tokens: 6881
  tasks: 3
  commits: 6
tech-stack:
  added: []
  patterns: [shared contract suite run per adapter, rejecting stubs for RED, async-only MountView so every failure is a rejection, runtime mode guard behind a type-level guard]
key-files:
  created:
    - src/storage/adapter.ts
    - src/storage/memory-adapter.ts
    - src/storage/mount-view.ts
    - test/contract/storage-adapter.contract.ts
    - test/unit/memory-adapter.test.ts
    - test/unit/mount-view.test.ts
  modified: []
key-decisions:
  - "read returns a Buffer capped by maxBytes (default 25 MiB) in Phase 1; a readStream is added beside it in Phase 4 (Open Question 1)"
  - "mkdir is strict: an existing folder is a conflict; Phase 3 may wrap it (Open Question 4)"
  - "MemoryAdapter.move never replaces a folder and refuses a move into the source's own subtree, both as conflict"
  - "MountView methods are async, so an invalid path rejects with invalid-path rather than throwing synchronously"
  - "Read-mount write methods check the mode before resolving the path, so they never touch Mounts or the adapter"
requirements-completed: [STOR-02]
requirements-partial: [STOR-04]
status: complete
duration: 5min
completed: 2026-11-21
commits: 6
plan_head_before: bb8129d7e3251392fb7cee624f44ee52117e0c23
plan_head_after: c3a3ac588aa8b3c920c5c365409434dd60693e95
---

# Phase 1 Plan 07: StorageAdapter, MemoryAdapter, contract suite and MountView Summary

**A `StorageAdapter` port with an in-memory adapter that passes a 33-case shared contract (by `StorageError` kind, never HTTP status), plus a `MountView` that rejects every write on a read mount at runtime with zero adapter calls.**

## Tasks

| Task | Type | RED | GREEN |
|------|------|-----|-------|
| 1. Write then read through a read-write MountView (contract tracer) | tracer, tdd | `a7d99d7` test | `5cf8f50` feat |
| 2. Full contract: every operation, error kind and edge | auto, tdd | `599e821` test | `5126641` feat |
| 3. Read-only mounts reject writes at runtime (STOR-02) | auto, tdd | `c1476de` test | `c3a3ac5` feat |

No REFACTOR commit was needed.

## TDD evidence (RED runs, all on assertions or "not implemented" rejections)

- **Task 1:** 2 of 2 failing (`MemoryAdapter.mkdir` rejected "not implemented"; the contract `afterEach` also failed because setup never produced a context). The RED commit carries the `StorageAdapter` interface, a `MountView` type skeleton and a MemoryAdapter whose methods reject, as the plan specifies, so the tests compile.
- **Task 2:** 15 of 34 failing: the `list`, `move` and `delete` stubs, plus one real semantic gap (write over a folder was accepted).
- **Task 3:** 3 of 7 failing: the read-mount write attempts reached the adapter, and an invalid path threw synchronously instead of rejecting.
- **GREEN:** `pnpm test` is 111/111 across the repo (41 in this plan's two files). `pnpm typecheck` and `pnpm lint` are clean on the whole repo.

## Acceptance checks

- `grep -c 'export function storageAdapterContract'` is 1.
- `grep -c '\.status'` in the contract file is 0.
- The contract has 33 `it(` cases (plan floor: 28).
- `grep -c 'ts-expect-error' test/unit/mount-view.test.ts` is 1, and `pnpm typecheck` passes with it, so `write` is absent from `ReadableMount`.
- The mount-view test asserts `spy.calls` is `[]` for each of the four rejected writes, for the unknown mount and for every invalid path.
- A `test(01-07)` commit precedes each `feat(01-07)` commit.

## Threat model

| Threat | Result |
|--------|--------|
| T-01-20 write on a read mount | Mitigated: methods are absent from `ReadableMount`, and a runtime `read-only-mount` guard is tested through a cast with zero adapter calls |
| T-01-21 delete on a folder | Mitigated in `MemoryAdapter` and pinned in the contract (empty and non-empty folder give conflict, children intact). WebDAV enforces it in 01-08 |
| T-01-22 cross-mount move | Mitigated by construction: `MountView.move` takes two relative paths of one mount |
| T-01-SC package installs | Accepted: no packages added |

## Deviations from Plan

None. The plan was executed as written.

## Deferred / Notes

- **STOR-04 is partial.** Only the in-memory half (interface plus `MemoryAdapter` passing the shared suite) is done here. The WebDAV half lands in 01-08, which runs `storageAdapterContract("webdav", ...)` against the Compose stack, so STOR-04 stays pending in REQUIREMENTS.md.
- **STOR-02 is complete.** 01-03 delivered mount allow-listing and path rejection, and this plan delivers the write-to-read-mount rejection.
- The contract does not pin `move` into a missing parent, `move` of a folder, or `move` onto a folder. `MemoryAdapter` rejects those with conflict, but 01-08 should check what hacdias and OX do before any of them is added to the contract.
- `ctx_execute` was used to read the plan file because the `context-mode` hook blocked `Read` on it.

### Execution environment notes (not plan deviations)

- Commits landed on `ZioHimself/snook`, the linked worktree's branch; `main` is checked out in the primary clone. No commit touched `main`.
- Plans 01-05 and 01-06 committed to the same branch and working tree while this plan ran. Every 01-07 commit used `git commit --only <paths>`, so no foreign file was staged. A raw `git rev-list --count plan_head_before..HEAD` would give 9 (3 foreign commits: `c77b342`, `c5fc9b5`, `1d6d8b9`). `commits: 6` is measured with `git log --grep='(01-07)'` and matches the six hashes above, the same method 01-03 used.
- `node_modules` was empty at start and was populated by another executor during this run. No install was run here.
- A single `pnpm lint` run printed one error mid-run (while another plan's files were in flight). `biome ci .` was clean immediately after and on every later run.

## Known Stubs

None.

## Threat Flags

None. The plan adds no network endpoints, auth paths or file access. `MemoryAdapter` is in-process only.

## Self-Check: PASSED

- FOUND: src/storage/adapter.ts, src/storage/memory-adapter.ts, src/storage/mount-view.ts, test/contract/storage-adapter.contract.ts, test/unit/memory-adapter.test.ts, test/unit/mount-view.test.ts
- FOUND commits: a7d99d7, 5cf8f50, 599e821, 5126641, c1476de, c3a3ac5
