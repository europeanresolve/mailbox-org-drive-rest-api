# OX App Suite / mailbox.org WebDAV compatibility matrix

- **Run date:** 2026-11-21 (plan 01-02)
- **Account class:** personal, fresh account
- **Method:** raw HTTP probe script plus web UI checklist
- **Anonymisation:** everything here is anonymised. Host, user folder, probe folder, dates, quota values and ETags are synthetic (`dav.example.invalid`, `Last, First`, `probe-2026-01-01`, epoch day 2026-01-01). OX ETags have been replaced by synthetic strings of the same shape.

## PROPFIND / ETag

| ID | Probe | RFC/dev-server expectation | Observed on OX | Impact on design | Fixture |
|----|-------|----------------------------|----------------|------------------|---------|
| P-02 | Depth 0 PROPFIND on a file | 207 with `getetag` (quoted on hacdias), `getlastmodified`, `getcontentlength`, `resourcetype` | 207, `getetag` unquoted (`<number>-<number>-<number>-<number>`), `getcontentlength` 20, `resourcetype` empty. `getlastmodified` carries a `b:dt="dateTime.rfc1123"` attribute, so the `webdav` client returns it as `{ text, "@dt" }` and `WebDavAdapter` maps `lastModified` to `null` (C-1) | `stat` size and ETag are usable as returned; `lastModified` needs a fix in plan 01-12 | `p02-propfind-depth0-file.xml` |
