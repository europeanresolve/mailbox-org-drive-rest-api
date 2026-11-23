# Phase 4: Read-only Content - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md. This log preserves the alternatives considered.

**Date:** 2026-11-23
**Phase:** 04-read-only-content
**Areas discussed:** Access & addressing, Sheet → JSON shape, Document → Markdown, Cache & refresh
**Ref:** #5

---

## Access & addressing

| Question | Options presented | Selected |
|----------|-------------------|----------|
| Addressing | Named in config / Path-based / Both | Path-based |
| Policy | Per resource / Per mount only / Always anonymous | Per mount only |
| Sheet/column exposure | Visible + header rule / Per-path overrides / Mount allow-list | Other: all columns always exposed; query params for hidden/system columns later |
| Hidden sheets | Expose too / Hide hidden sheets | Expose too |
| Worksheet selection | Path segment / Query param / Always all sheets | Path segment, following the write API convention |
| Bare workbook URL | Sheet index / First sheet's rows | Other: `GET /v1/{dir}/` lists with info; `file.xlsx` gives all sheets; `file.xlsx/{sheet}` gives one |
| Files exposed | All except dotfiles / Extension allow-list / Everything | Everything |
| URL scheme | One tree under /v1/files / Keep 3 prefixes / Mounts at /v1 root | Mounts at /v1 root; shared namespace with collections, clashes rejected; `?download` for raw |
| Row counts in listing | From cache / Only if cached / None | From cache |
| Mount modes served | read only / All mounts / read + opt-in | All mounts, explicit configuration required |
| Grants | `{mount}:read` deny by default / Anonymous by default | `{mount}:read`, deny by default |

**Notes:** The user believed `/v1/{mount}/{dir}` was already the write API's shape. The code showed `/v1/{collection}[/{id}]`, with collection names that are logical, not mounts. The user confirmed mounts at the `/v1` root anyway. A clash check on the collection's first segment was added. "Authorization is important" means the mirror mount is served only when configured explicitly.

## Sheet → JSON shape

| Question | Options presented | Selected |
|----------|-------------------|----------|
| Row keys | Raw header text / Normalised / Arrays + header list | Raw header text |
| Cell types | Native JSON / All strings / Native + omit empty | Native JSON |
| Envelope | Objects with metadata / Bare data / Paginated | Objects with metadata (later aligned to `{items, nextCursor}`) |
| DTO structure | Same envelope, flat rows / Unflatten into records / Unflatten dots only | Unflatten into records |
| Array join | Mirror naming convention / Known mirror files only / Never | Mirror naming convention |
| Header conflicts | Fall back to flat / Fail 422 / Flat key wins | Other: fail fast with a server error, using the listing envelope with an error property |
| System columns | Plain headers / Lift into metadata | Plain headers |
| Error shape | Envelope with per-item error / Error at top / problem+json | Envelope with per-item error |
| Stale on parse failure | Last good version / Error immediately | Error immediately (READ-07 reworded to cover Drive outages only) |

**Notes:** The user interrupted to ask that responses match the write API's DTOs (request record, `{...data, id, createdAt, updatedAt}`, `{items, nextCursor}`).

## Document → Markdown

| Question | Options presented | Selected |
|----------|-------------------|----------|
| Format | JSON envelope / Raw text/markdown / Negotiated | JSON envelope |
| Images | Per mount default drop / default inline / Global | Other: extract images to Drive, linked by URL |
| Images (follow-up) | Virtual sub-path / Extract to Drive / Sub-path + options | Extract to Drive (sibling folder idea), permissions to be discussed |
| Image target | Configured assets mount / Sibling read-write only / Sibling opt-in | Configured assets mount |
| Image access | Inherit doc's policy / Assets mount's policy | Inherit doc's policy |
| Image sync | Rewrite changed, delete removed / Write-only | Rewrite changed, delete removed |
| Sanitisation | Allow-list schemes, no raw HTML / + HTML tables | Allow-list schemes, no raw HTML |

## Cache & refresh

| Question | Options presented | Selected |
|----------|-------------------|----------|
| TTL scope | Global + per-mount override / Global only | Global + per-mount override |
| Cache-Control | Policy-aware / Always no-cache / max-age everywhere | Policy-aware |
| Files cache | Listings yes, downloads no / Cache under cap / Nothing | Listings yes, downloads no |
| Operator refresh | POST on resource / Root operator route / Per-mount grant | Root operator route (`POST /cache/refresh`, `cache:refresh`) |
| Limits | Global defaults overridable / Fixed in code | Global defaults overridable |

## Claude's Discretion

- `tel:` links, the 5xx status code for parse failures, the single-flight mechanism, config key names, OpenAPI for dynamic paths.

## Deferred Ideas

- Query params to hide hidden sheets/columns or system columns (`id`, `createdAt`, `updatedAt`, `index`, `value`).
- Recursive listings and listing pagination.
