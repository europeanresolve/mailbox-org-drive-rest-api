---
phase: 03-mirror-worker
plan: 02
subsystem: mirror
tags: [exceljs, columns, content-hash, sanitization, tdd]
requires:
  - phase: 03-mirror-worker
    plan: 01
    provides: buildWorkbook tracer and exceljs quarantine
provides:
  - planColumns with nested flattening and array metadata
  - typed sanitised main-sheet cells and canonical contentHash
affects: [03-03, 03-04, 03-06]

actuals:
  tokens: 92000
  tasks: 2
  commits: 5
plan_head_before: e956bb0aa7e2fa9bc72ad73d53e4553317c40bbe
plan_head_after: 7c144a2f93e08d64053d62866507d123cb3500b6

tech-stack:
  added: []
  patterns:
    - model-first contentHash over sheet model JSON
    - text numFmt for attacker-controlled strings
    - pure planColumns module without exceljs

key-files:
  created:
    - src/mirror/columns.ts
    - test/unit/mirror-columns.test.ts
    - test/unit/mirror-workbook.test.ts
  modified:
    - src/mirror/workbook.ts

key-decisions:
  - "ArrayField.position is the index of the last main column before the array (after id/schema prefix)"
  - "contentHash includes MIRROR_FORMAT_VERSION and header order, not xlsx bytes"

patterns-established:
  - "Strip illegal XML and lone surrogates without control-char regex (biome-safe)"
  - "Render cells via model then per-cell exceljs setters with @ or date numFmt"

requirements-completed: [MIRR-04, MIRR-05, MIRR-06]

coverage:
  - id: D1
    description: "Schema-stable columns with nested dotted headers and array positions"
    requirement: MIRR-04
    verification:
      - kind: unit
        ref: test/unit/mirror-columns.test.ts
        status: pass
    human_judgment: false
  - id: D2
    description: "Formula-prefix and oversize strings stay inert string cells"
    requirement: MIRR-05
    verification:
      - kind: unit
        ref: test/unit/mirror-workbook.test.ts
        status: pass
    human_judgment: false
  - id: D3
    description: "Canonical contentHash stable for identical data and sensitive to schema order"
    requirement: MIRR-06
    verification:
      - kind: unit
        ref: test/unit/mirror-workbook.test.ts#stable contentHash
        status: pass
    human_judgment: false
  - id: D4
    description: "Tracer mirror integration still writes contact.xlsx after create"
    requirement: MIRR-01
    verification:
      - kind: integration
        ref: test/integration/mirror.test.ts
        status: pass
    human_judgment: false

duration: 35min
completed: 2026-11-23
status: complete
---

# Phase 03 Plan 02: Column model and workbook hardening Summary

**Main-sheet columns follow the collection schema; cells are typed, sanitised, and hashed without trusting xlsx bytes.**

## Performance

- **Duration:** 35 min
- **Tasks:** 2 / 2
- **Commits:** 5 on branch (4 for plan 03-02; +1 pre-existing `test(03-06)` between feat and workbook test)

## TDD Gate Compliance

| Task | RED commit | GREEN commit | Evidence |
|------|------------|--------------|----------|
| 1 Column model | 3acc3ee | 9c71c7c | vitest import failure then 6/6 pass |
| 2 Workbook hardening | da0fa01 | 7c144a2 | 6 failures on assertions then 21/21 pass |

## Accomplishments

- `planColumns` walks `properties` in source order, flattens nested objects to dotted headers, records array fields for 03-03, and pins `id` / `createdAt` / `updatedAt`.
- `buildWorkbook` builds a sheet model, hashes `{ v: MIRROR_FORMAT_VERSION, sheets }`, then renders with frozen row 1, UTC date cells, `sanitizeString`, and `@` text format for strings.
- Unit tests cover seven formula-prefix shapes, illegal XML, surrogate-safe truncation, and hash stability; integration tracer remains green.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Carriage return in xlsx readback**
- **Found during:** Task 2
- **Issue:** Excel stores `\r` as `\n` in string cells; strict equality on `\rx` failed while type remained String with no formula.
- **Fix:** Unit test expects `\nx` for the CR case; still asserts no formula/hyperlink.
- **Files modified:** test/unit/mirror-workbook.test.ts
- **Commit:** 7c144a2

None else — plan executed with the CR note above.

## Commits

| Hash | Message |
|------|---------|
| 3acc3ee | test(03-02): add failing tests for planColumns |
| 9c71c7c | feat(03-02): planColumns and workbook column wiring |
| da0fa01 | test(03-02): add failing tests for workbook safety and hash |
| 7c144a2 | feat(03-02): sanitised cells, dates and contentHash |

## Self-Check

```text
FOUND: src/mirror/columns.ts
FOUND: src/mirror/workbook.ts
FOUND: test/unit/mirror-columns.test.ts
FOUND: test/unit/mirror-workbook.test.ts
FOUND: .planning/phases/03-mirror-worker/03-02-SUMMARY.md
FOUND: 3acc3ee
FOUND: 9c71c7c
FOUND: da0fa01
FOUND: 7c144a2
```

## Self-Check: PASSED