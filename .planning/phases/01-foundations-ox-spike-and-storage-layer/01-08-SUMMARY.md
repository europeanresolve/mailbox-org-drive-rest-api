---
phase: 01-foundations-ox-spike-and-storage-layer
plan: 08
subsystem: storage
tags: [webdav, storage-adapter, retry, p-retry, p-limit, cooldown, contract-suite, fake-server, tdd]
requires:
  - phase: 01-07
    provides: "StorageAdapter port, MemoryAdapter, storageAdapterContract (33 cases)"
  - phase: 01-11
    provides: "Compose stack, integration project, global-setup STACK and runId"
provides:
  - "WebDavAdapter over webdav 5.11.0: concurrency cap, bounded retry, Retry-After cap, 401 cooldown, path-free errors"
  - "startFakeWebDav(), propfindReply(): in-process node:http WebDAV fake with scripted faults, request recording and in-flight counting"
  - "storageAdapterContract(\"webdav\") passing against the Compose hacdias server, 33 cases, same as the memory run"
affects: [01-09, 01-10, 01-12, 02, 03, 04]
actuals:
  tokens: 9434
  tasks: 3
  commits: 7
tech-stack:
  added: []
  patterns: [limit(() => pRetry(...)) with the slot held across backoff, raw library error reduced to an internal Failure then to StorageError(kind, op, status) with no cause, verification stat on the raw client inside the held slot, scripted fake server layered over default replies]
key-files:
  created:
    - src/storage/webdav-adapter.ts
    - test/helpers/fake-webdav-server.ts
    - test/unit/webdav-adapter.test.ts
    - test/integration/webdav-adapter.contract.test.ts
  modified: []
key-decisions:
  - "A reply without a status in the fake server is layered over the default reply, so { delayMs } alone delays the normal answer"
  - "A Retry-After above maxRetryAfterMs gives rate-limited for any retryable response (429, 502, 503, 504), not only 429"
  - "A PUT that fails with 404 triggers one Depth 0 stat of the target; a folder there gives conflict (hacdias answers PUT onto a folder with 404)"
  - "A MOVE source found missing after 403, 409 or 412 reports status 404 (the stat's status), not the MOVE's"
requirements-completed: [STOR-04, STOR-05]
status: complete
duration: 9min
completed: 2026-11-21
commits: 7
plan_head_before: 2c5036b0a934b598e1acce0dfa115f90a33dd079
plan_head_after: 7e29a4deeb14b9393a583bbe8dd27f2fef488e0d
---

# Phase 1 Plan 08: WebDavAdapter, retry, cooldown and shared contract Summary

**`WebDavAdapter` passes the same 33-case contract as `MemoryAdapter` against Compose hacdias, retries only 429/502/503/504/network/timeout with bounded backoff inside a held concurrency slot, opens a 60 s cooldown on 401, never sends a deep PROPFIND, and throws path-free `StorageError`s only.**

## Tasks

| Task | Type | RED | GREEN |
|------|------|-----|-------|
| 1. Stat one file on Compose through limit, retry, client and mapping | tracer, tdd | `ce00657` test | `6f10329` feat |
| 2. Retry, no-retry, cooldown, Retry-After, Depth, concurrency and leak tests | auto, tdd | `f36a010` test | `ef3123c` feat |
| 3. All operations pass the shared contract against Compose | auto, tdd | `3889d48` test, `b675a38` test | `7e29a4d` feat |

No REFACTOR commit was needed.

## TDD evidence (RED runs, all on assertions or "not implemented" rejections)

- **Task 1:** 1 of 1 failing: `stat` rejected `unavailable` from the skeleton adapter (`StorageError: stat: unavailable`).
- **Task 2:** 3 of 17 failing on behaviour: the Retry-After wait (elapsed 3 ms against the 900 ms floor), the Retry-After cap (the call retried and succeeded instead of giving `rate-limited`), and the 401 cooldown (the second call was not rejected). The other 14 already passed because Task 1 delivered the wrapper order the plan specifies (retry classification, slot held across retries, timeouts, path-free errors).
- **Task 3:** 14 of 30 unit tests failing and 33 of 34 integration tests failing (every contract case; the stat tracer passed).
- **Extra RED:** the Compose contract exposed one real gap after GREEN: `rejects writing over a folder with conflict` got `not-found`. A unit test for it (`b675a38`) failed first, then the fix went into `7e29a4d`.
- **GREEN:** `pnpm test` 195/195 (the WebDAV unit file has 32 tests and runs in about 2 s), `pnpm test:integration` 36/36 (the WebDAV file is 34 tests: 33 contract plus the tracer, the same 33 as `pnpm test test/unit/memory-adapter.test.ts`, which has 34 with its MountView tracer). The WebDAV integration file passed 3 consecutive extra runs. `pnpm typecheck` and `pnpm lint` are clean.

## Acceptance checks

- A `test(01-08)` commit precedes every `feat(01-08)` commit.
- `grep -c 'implements StorageAdapter'` is 1; `grep -c 'application/xml'` is 1.
- The unit file has one test per behaviour bullet, including the four canary classes (401, 404, exhausted 503, ECONNREFUSED), each asserting `String(err)`, `err.stack` and `JSON.stringify(err)` hold no `canary-7f3a` and `err.cause` is undefined.
- A scripted 503, 503, 207 sequence makes exactly 3 requests. 401 and 403 make exactly 1. During the 401 cooldown 0 new requests are recorded.
- 10 concurrent stats at concurrency 2 give `maxInFlight === 2`. At concurrency 1 a retried call keeps its slot (`/m/a`, `/m/a`, `/m/b`).
- A retried MOVE verified at concurrency 1 finishes inside the 2 s race.
- `pnpm test test/unit/memory-adapter.test.ts` still passes: the contract was not weakened.

## Threat model

| Threat | Result |
|--------|--------|
| T-01-23 credential lockout via retried 401 | Mitigated: 401 and 403 are not retryable; a 401 opens `cooldownMs` (default 60 s), checked before queueing and again inside the slot. Tests assert request counts. |
| T-01-24 retry storm, deep PROPFIND | Mitigated: concurrency 2 held across retries, 4 retries, 500 ms to 8 s backoff with jitter, 60 s `maxRetryTime`, Retry-After capped at 30 s, no `deep` or `glob`. The Depth sweep over all seven operations records only Depth 0 or 1. |
| T-01-25 library errors with URLs | Mitigated: `classify` reduces the raw error to kind, status and flags; `StorageError` has no cause. Canary tests cover four failure classes. |
| T-01-26 hostile XML, oversized bodies | Mitigated as far as the plan allowed: `entityDecoder` limits and 64 MiB client caps are set (effectiveness still assumed, A5), plus the stat-before-read `maxBytes` check and the post-download length check. |
| T-01-27 duplicate side effects on retried MOVE/DELETE | Mitigated: a verification stat on the raw client inside the held slot; 404 after a retried DELETE and "source gone, destination present" after a retried MOVE count as success. |
| T-01-SC package installs | Accepted: no packages added; the `glob` option is never used. |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] PUT onto a folder returned not-found on hacdias**
- **Found during:** Task 3 (Compose contract run)
- **Issue:** hacdias answers a PUT onto an existing folder with 404, so `write` reported `not-found` where the contract requires `conflict`. The plan only named 405 and 409.
- **Fix:** on a PUT 404, `write` does one Depth 0 stat of the target; a folder gives `conflict` (status 404 kept), anything else stays `not-found`. Two unit tests pin both sides.
- **Files modified:** `src/storage/webdav-adapter.ts`, `test/unit/webdav-adapter.test.ts`
- **Commits:** `b675a38` (RED), `7e29a4d` (GREEN)

### Plan-order adjustments (no behaviour change)

- **Task 1 GREEN stopped short of the cooldown and Retry-After.** The plan's Task 1 action lists them, but Task 2 owns their tests. They were left out of Task 1 so Task 2 had a real RED (3 of 17), and landed in Task 2 GREEN (`ef3123c`).
- **The Depth sweep in Task 2 became a seven-operation sweep in Task 3.** In Task 2 only `stat` existed, so the all-operations sweep was written in Task 3's RED, where it failed against the skeleton.
- **`cooldownMs` and `maxRetryAfterMs` were added to `WebDavAdapterOptions` in Task 2's RED commit** (type only, unused) so the RED commit typechecks.

## Deferred / Notes

- **STOR-04 and STOR-05 are both complete.** The WebDAV half of STOR-04 lands here, and STOR-05's retry, no-retry, concurrency and Depth rules are each proven against a real HTTP server.
- **Defaults are the plan's discretion, not OX-derived** (assumption A7). 01-10 records the spike data and 01-12 adjusts them.
- **Retryable network codes** are the six the plan lists, plus any `AbortSignal` timeout. A node-fetch `FetchError` with another code (for example `ERR_STREAM_PREMATURE_CLOSE`) is classified `unavailable` and not retried. The destroyed-socket test passes because Node reports it as `ECONNRESET`.
- **`move` into a missing parent** gives `forbidden` on hacdias (403 with the source present), while `MemoryAdapter` gives `conflict`. The contract does not pin it, as 01-07 noted; 01-10 and 01-12 should see what OX does before it is added.
- **Plan 01-05 is still incomplete** (it was at a checkpoint). Its `ci.yml` commit `c77b342` was not touched, and every 01-08 commit used `git commit --only <paths>`.
- `ctx_execute` was used to read the plan, research and config files because the `context-mode` hook blocked `Read` and `Grep` on large files.

### Execution environment notes (not plan deviations)

- Commits landed on `ZioHimself/snook`, the linked worktree's branch, as the dispatch directed. No commit touched `main`.
- Docker and the integration tests needed the sandbox lifted (`pnpm stack:up` could not reach the Docker socket in the default sandbox). The Compose stack from `pnpm stack:up` is left running.
- `commits: 7` is the raw `git rev-list --count` from `plan_head_before`; all seven are `(01-08)` commits (no foreign commits landed during this run).

## Known Stubs

None.

## Threat Flags

None. The adapter is an outbound client of the already modelled Drive boundary (T-01-23 to T-01-27); it adds no listener, auth path or schema. The fake server binds to 127.0.0.1 on a random port in tests only.

## Self-Check: PASSED

- FOUND: src/storage/webdav-adapter.ts, test/helpers/fake-webdav-server.ts, test/unit/webdav-adapter.test.ts, test/integration/webdav-adapter.contract.test.ts
- FOUND commits: ce00657, 6f10329, f36a010, ef3123c, 3889d48, b675a38, 7e29a4d
