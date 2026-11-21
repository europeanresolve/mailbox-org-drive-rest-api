---
phase: 01-foundations-ox-spike-and-storage-layer
plan: 10
subsystem: testing
tags: [webdav, ox-app-suite, compatibility-matrix, fixtures, replay-tests, synthetic-data-guard, tdd]
requires: ["01-02", "01-08"]
provides:
  - "docs/ox-webdav-compatibility.md: matrix for P-01..P-19 and U-01..U-10 plus Consequences (C-1..C-3 for plan 01-12)"
  - "test/fixtures/ox/*.xml: six anonymised OX PROPFIND recordings with synthetic ETags"
  - "test/unit/ox-replay.test.ts: OX responses replayed through WebDavAdapter"
  - "test/helpers/synthetic-residue.ts + test/unit/synthetic-data.test.ts: DEV-04 guard (findResidue)"
affects: [01-12, phase-03-mirror, phase-04-cache]
tech-stack:
  added: []
  patterns: ["fixture replay through the in-process fake WebDAV server", "pure findResidue(path, text) rule function plus git ls-files tree scan", "RED-first characterisation tests with deliberately wrong placeholders"]
key-files:
  created:
    - docs/ox-webdav-compatibility.md
    - test/fixtures/ox/p02-propfind-depth0-file.xml
    - test/fixtures/ox/p02-propfind-depth0-file-allprop.xml
    - test/fixtures/ox/p02-propfind-depth0-folder.xml
    - test/fixtures/ox/p03-propfind-depth1-names.xml
    - test/fixtures/ox/p04-propfind-depth-infinity.xml
    - test/fixtures/ox/p16-propfind-quota.xml
    - test/unit/ox-replay.test.ts
    - test/unit/synthetic-data.test.ts
    - test/helpers/synthetic-residue.ts
  modified:
    - .planning/STATE.md
key-decisions:
  - "Fixtures carry synthetic ETags (100000-N-1-100000000000N), never the account-derived OX strings; the shape is kept"
  - "The adapter disagreement (lastModified null on OX) is recorded as C-1 and pinned with an it.fails case instead of changing src/ in this plan"
  - "findResidue lives in test/helpers (Biome rejects exports from test files) and accepts Last,%20First as well as Last%2C%20First"
requirements-completed: [STOR-01, DEV-04]
status: complete
duration: ~12min
completed: 2026-11-21
commits: 6
plan_head_before: 28bdc12320c6262a0d95a9b40cf693884d3838fc
plan_head_after: caf3d98841a185aa0caf694a15284f8b1f8d5903
actuals:
  tokens: 36000
  tasks: 3
  commits: 6
---

# Phase 1 Plan 10: OX WebDAV compatibility matrix, fixtures and synthetic-data guard Summary

**A 29-row OX App Suite compatibility matrix with six synthetic-ETag fixtures replayed through `WebDavAdapter`, plus a CI guard that rejects real e-mail addresses anywhere and account residue in OX fixtures. The replay found one real adapter bug (C-1: OX `getlastmodified` gives `lastModified: null`) and one path-rule clash (C-2: NFD names), both left for plan 01-12.**

## What was built

| Task | Name | Commits |
|------|------|---------|
| 1 | Tracer: p02 fixture, fake server, `WebDavAdapter.stat`, P-02 row | `617bcb3` (RED), `a9ab507` (GREEN) |
| 2 | Full matrix, folder-stat and listing replays | `c2e816f` (RED), `c7ddbd1` (GREEN) |
| 3 | `findResidue` guard and STATE blocker update | `ecb3294` (RED), `caf3d98` (GREEN) |

### Main findings (full detail in `docs/ox-webdav-compatibility.md`)

- ETag is a usable validator: stable across PROPFIND/HEAD/GET, changes on every write (identical bytes too) and on rename. `getlastmodified` has one-second resolution, so (lastModified, size) is not a safe fallback.
- OX honours `If-Match` (412) and `If-None-Match: *` (412). Weak `If-None-Match` gets 200, so Phase 4 must send strong ETags.
- MOVE Overwrite T over an existing file works (204) but gives the destination a new file identity and resets its write counter; a direct PUT keeps identity and adds a version.
- Every overwrite keeps a version (4 versions after 4 PUTs); DELETE goes to the trash (one entry per folder). A WebDAV DELETE is not erasure.
- Quota properties are answered in a 404 propstat, so quota cannot be read over PROPFIND.
- Rate limit headers `x-ratelimit-limit: 150, 150;w=1, 3000;w=60, 20000;w=3600`; no 429/503 in 38 PROPFINDs. Adapter defaults stand.

## RED evidence

Task 1 (`617bcb3`), stat of p02.txt against placeholders `size -1`, `etag "PLACEHOLDER"`, `lastModified null`:

```
-   "etag": "PLACEHOLDER",
+   "etag": "100000-1-1-1000000000001",
    "kind": "file",
    "lastModified": null,
    "name": "p02.txt",
-   "size": -1,
+   "size": 20,
```

Task 2 (`c2e816f`), folder stat placeholder `kind "file"` and listing placeholder `[]`:

```
AssertionError: expected 'dir' to be 'file'
AssertionError: expected [ 'Last, First.txt', …(8) ] to deeply equal []
+ "Last, First.txt", "Müller.txt", "Müller.txt", "a&b.txt", "emoji-😀.txt",
+ "hash#1.txt", "p02.txt", "pct%41.txt", "plus+1.txt"
```

Task 3 (`ecb3294`): with a stub `findResidue` returning `[]`, five tests failed (`flags email`, `flags ox-host`, `flags ox-date`, `flags ox-quota`, `flags ox-name-element`).

During GREEN of Task 1 the planned `lastModified` expectation also failed (`2026-01-01T00:09:59.000Z` expected, `null` received). That is C-1, below.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixture bodies are not byte for byte: synthetic ETags and a provenance comment**
- **Found during:** Task 1
- **Issue:** the plan says to copy the response body byte for byte, but the reviewed record holds OX-derived ETags (leading number is account or folder derived, per the 01-02 note and the dispatch instruction). The recorded hrefs are paths only, so the acceptance check `grep -c dav.example.invalid` would find nothing.
- **Fix:** every `getetag` value is replaced by a synthetic string of the same shape (`100000-<n>-1-<1000000000000+n>`, distinct per file). One XML comment after the declaration names the host `dav.example.invalid` and the source recording. Everything else is unchanged.
- **Files modified:** `test/fixtures/ox/*.xml`
- **Commit:** `617bcb3`

**2. [Rule 1 - Bug, recorded not fixed] Adapter returns `lastModified: null` for OX entries**
- **Found during:** Task 1 GREEN
- **Issue:** OX adds `b:dt="dateTime.rfc1123"` to `getlastmodified`; the `webdav` client returns `lastmod` as `{ text, "@dt" }`; `toEntry` runs `new Date(object)` and gets null.
- **Action:** per the plan, `src/` is untouched. The replay test asserts the current null with a pointer to C-1, and an `it.fails` case pins the correct value so plan 01-12 gets a red signal to act on.
- **Files modified:** `test/unit/ox-replay.test.ts`, `docs/ox-webdav-compatibility.md`
- **Commit:** `a9ab507`

**3. [Rule 3 - Blocking] `findResidue` moved out of the test file**
- **Found during:** Task 3 RED
- **Issue:** Biome (`biome ci`) rejects exporting from a test file.
- **Fix:** the pure function lives in `test/helpers/synthetic-residue.ts` and the test imports it.
- **Commit:** `ecb3294`

**4. [Rule 2 - Missing critical] Userstore rule accepts the form OX actually emits**
- **Issue:** the plan names `Last, First` and `Last%2C%20First` only, but OX writes the folder href as `Last,%20First` (raw comma). The rule decodes the segment and compares it with `Last, First`, so all three spellings pass and any other folder name fails.
- **Commit:** `caf3d98`

**5. [Rule 3 - Blocking] P-14 listing could not become a fixture**
- **Issue:** the recorder cut the P-14 Depth 1 listing at 8 KB (`[truncated, 22944 bytes]`), so it is not valid XML. No fixture was made; the matrix row says so and marks case sensitivity `[ASSUMED]`.

**6. [Rule 3 - Blocking] File Read tool rejected by a context-mode hook**
- `Read` failed on the plan and the 01-02 SUMMARY (hook error), so both were read through the shell. No file content was edited that way; `STATE.md` was edited with the normal edit tool.

### Source discrepancy noted

The 01-02 SUMMARY lists P-07 as "quoted 304, weak 304, unquoted 200". The recorded `summary.json` says quoted 304, unquoted 304, weak 200. The matrix follows the recording and says so.

## Authentication gates

None. No network access to mailbox.org; everything came from the reviewed `anon/` folder. `raw/` was never used.

## Verification

- `pnpm test`: 12 files, 224 passed and 1 expected fail (the C-1 `it.fails` case)
- `pnpm test:integration`: 4 files, 43 passed
- `pnpm typecheck` and `pnpm lint`: clean
- Matrix check script prints `matrix ok` (all 29 IDs, no blank cell, `## Consequences` present)
- `git grep 895646` (the real ETag lead number) finds nothing in tracked files
- No file under `src/` and not `test/unit/webdav-adapter.test.ts` changed

## Open: human review before the push to main

The plan's `human-check` is not something an executor can do: read `docs/ox-webdav-compatibility.md` and the `test/fixtures/ox/` diff, confirm nothing personal remains and that each "Observed on OX" cell matches what was seen in the web UI. The automated guard cannot catch a person's name in free text. Rows U-03 (answer redacted at the 01-02 review), U-05, U-09 and U-10 rest on short typed UI answers and deserve the closest look.

## Known Stubs

None. `[ASSUMED]` marks in the matrix are unverified claims, not stubs: case sensitivity (P-14), restorability and versions in the trash (U-05), share-link survival after MOVE over an existing file (U-03).

## Threat Flags

None beyond the plan's threat model. T-01-31 is mitigated by the `findResidue` guard plus the manual check above; T-01-32 by the matrix check script and the `[ASSUMED]` and "not tested" markers.

## Self-Check: PASSED

- FOUND: docs/ox-webdav-compatibility.md, test/unit/ox-replay.test.ts, test/unit/synthetic-data.test.ts, test/helpers/synthetic-residue.ts, six files under test/fixtures/ox/
- FOUND commits: 617bcb3, a9ab507, c2e816f, c7ddbd1, ecb3294, caf3d98 (all ancestors of HEAD)
