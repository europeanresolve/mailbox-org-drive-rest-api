# API Coverage — WebDAV (mailbox.org Drive / OX App Suite infostore)

> Full coverage by default. Opt-outs are explicit, reasoned decisions.

Surface integrated by `WebDavAdapter` (plan 01-08) behind the `StorageAdapter` port (plan 01-07). The OX spike (plans 01-02, 01-10) probes more verbs than the adapter uses; probing is not integration.

| capability | decision | reason |
|---|---|---|
| PROPFIND Depth 0 (stat: etag, size, last-modified, resourcetype) | INTEGRATE | |
| PROPFIND Depth 1 (shallow folder listing) | INTEGRATE | |
| GET (read file as Buffer, capped by maxBytes) | INTEGRATE | |
| PUT (create or replace file) | INTEGRATE | |
| MKCOL (create folder) | INTEGRATE | |
| MOVE with Overwrite T/F (rename, replace) | INTEGRATE | |
| DELETE of a file | INTEGRATE | |
| PROPFIND Depth infinity | OPT-OUT | explicitly out of scope: STOR-05 forbids deep traversal; probed once by the spike only |
| DELETE of a folder (recursive) | OPT-OUT | explicitly out of scope: the adapter refuses folder deletes so one call cannot wipe staff work |
| COPY | OPT-OUT | not needed: no v1 use case |
| LOCK / UNLOCK | OPT-OUT | not needed: the design does not rely on locks; the spike records OX behaviour (P-09) |
| PROPPATCH (custom properties) | OPT-OUT | not needed: no custom properties in v1 |
| Conditional PUT (If-Match / If-None-Match) | OPT-OUT | not needed yet: not enforced by the dev servers; the spike records OX behaviour (P-08) for the Phase 3 mirror decision |
| Conditional GET (If-None-Match, 304) | OPT-OUT | not needed yet: the Phase 4 cache validates with a Depth 0 stat |
| Quota properties (quota-available-bytes, quota-used-bytes) | OPT-OUT | not needed yet: recorded by spike P-16 |
| OPTIONS (DAV class discovery) | OPT-OUT | not needed: the spike records it (P-01); the adapter assumes class 1 verbs |
| Streaming read | OPT-OUT | not needed yet: Phase 4 adds readStream next to read (research Open Question 1) |
| Versions and trash access (OX HTTP API) | OPT-OUT | explicitly out of scope: deferred to v2.0 erasure work (CONTEXT deferred ideas); the spike only observes them via the web UI |
