# Phase 3: Mirror Worker - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-22
**Phase:** 03-mirror-worker
**Areas discussed:** Drive write strategy, Where mirrors live, Columns and cell format, Timing and operator API, Nested collections (added)

---

## Drive write strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Direct PUT | Keeps file id, versions, share links; small torn-read risk; no temp files | ✓ |
| Temp + MOVE | No torn reads; new file identity per write; orphan cleanup | |
| Configurable per collection | Two code paths | |

Foreign change (ETag differs): **Overwrite + record it** (vs overwrite silently, stop and flag).
Reword MIRR-03 / SC3 to match: **yes**.

## Where mirrors live

- On by default (vs opt-in), then hardened to **required, no opt-out** once the user explained that the mirror is the core purpose ("MongoDB primarily stores collections to be stored to the Drive").
- User asked whether the collection name as file name is a security risk. Answer: no. Names come from config only, match `^[a-z][a-z0-9-]{0,31}$`, and no request chooses a Drive path.
- Collisions: impossible because collection names are unique (user's point), so the file is `<collection>.xlsx` in one global mirror mount.
- Existing staff file on first write: **Overwrite + record** (vs refuse until rebuild).

## Columns and cell format

| Question | Options | Choice |
|----------|---------|--------|
| Column order / headers | Schema order + title; schema order + raw keys; alphabetical | Schema order, raw keys |
| Nesting | Flatten objects + join arrays; JSON text | Flatten objects; arrays spread, then a **separate sheet per array** |
| System columns | None; via mapping | Include all Mongo fields (user reconsidered); id first, createdAt/updatedAt last |
| Array summary in main sheet | Server-joined text; generated formulas; nothing | **Generated formulas**, chosen by a user test in mailbox.org; server-joined text is the fallback |
| Object arrays | Column per field; you decide | Column per field + index, flattened |
| Row order | Oldest first; newest first | Oldest first |
| Dates | Excel dates; ISO text | Excel dates |
| Long cells | Truncate with marker; you decide | Truncate with marker |
| Config column mapping | Select/order/rename; rename only; drop | **Drop** (reword MIRR-04) |

## Timing and operator API

- Debounce: user set **config.yaml, 15 s, max wait 3 min** (offered 30 s/5 min, 5 s, 2 min).
- Reconciler: the user asked whether it could be the same job as the write from MongoDB. Agreed: the forced full pass is the worker job, **every 15 min**, and API writes also trigger it.
- Routes: user proposed `/mirror/status` and `/mirror`. Pinned to **unversioned `GET /mirror/status` + `POST /mirror`** (vs under `/v1`, per-collection grants).
- Role: **ROLE env var, default all**.

## Nested collections (added by the user)

The user asked for the CRUD API path to map to the Drive path. Recommended deferring it to its own phase; the user chose to **pull it into Phase 3**.

| Question | Choice |
|----------|--------|
| Contract | Slash-separated names (vs separate `folder` field) |
| Depth | No limit (vs 4) |
| Shared prefixes | Allowed |

## Claude's Discretion

Rebuild semantics, status payload, formula-guard style, Drive outage behaviour, lease/fencing details, Mongo collection naming for nested names, ambiguous property keys, array sheet naming.

## Deferred Ideas

None.
