---
phase: 02-collections-access-policy-and-anonymous-hardening
reviewed: 2026-11-22T12:30:00Z
depth: standard
files_reviewed: 22
files_reviewed_list:
  - src/app.ts
  - src/server.ts
  - src/keygen.ts
  - src/auth/api-keys.ts
  - src/collections/definition.ts
  - src/collections/hardening.ts
  - src/collections/idempotency.ts
  - src/collections/if-match.ts
  - src/collections/indexes.ts
  - src/collections/list-query.ts
  - src/collections/merge-patch.ts
  - src/collections/routes.ts
  - src/collections/store.ts
  - src/collections/validator.ts
  - src/config/load.ts
  - src/config/schema.ts
  - src/http/docs.ts
  - src/http/logging.ts
  - config/config.example.yaml
  - deploy/kong.yml
  - deploy/kong-check.sh
  - package.json
findings:
  critical: 0
  warning: 5
  info: 6
  total: 11
  necessity: 0
status: issues_found
---

# Phase 02: Code Review Report

**Reviewed:** 2026-11-22T12:30:00Z
**Depth:** standard
**Files Reviewed:** 22
**Status:** issues_found

## Summary

Reviewed all Phase 02 source (collections, API keys, list/keyset paging, If-Match, merge-patch, idempotency, hardening, OpenAPI docs, config, Kong reference) plus the example config and README claims. Tests were scanned for reliability problems only (no `.only`/`.skip`, no hardcoded real secrets).

The core design is sound. Mongo filters are built from typed scalars under allow-listed field names. Cursors are strictly validated. Key comparison is constant-time. Error bodies never echo input. The idempotency takeover reuses the record id, so a double insert is impossible. Indexed paths must be required scalars, which avoids the null-bracket keyset problem.

I found no data-loss or authentication-bypass defects, so there are no Critical findings. The Warnings are a startup index failure mode that can silently disable the idempotency TTL index, a cursor that breaks for large integer values, `If-Match` silently ignored on `DELETE`, a gap in the unbounded-string check, and a Kong rate limit that also throttles authenticated writes.

## Warnings

### WR-01: Index name collision aborts all index setup, including the idempotency TTL index

**File:** `src/collections/indexes.ts:11-30`
**Issue:** The index name is `idx_${path.replaceAll(".", "_")}`. The dotted path `a.b` and the top-level field `a_b` are both valid, required scalar index paths (`unsafeName` only rejects `.`, `$` and a leading `_`). Both map to `idx_a_b` with different keys. MongoDB then rejects the `createIndexes` batch with an `IndexKeySpecsConflict`.

The loop is not isolated per collection. The throw at line 12 aborts the whole `ensureIndexes`:
- Later collections never get their indexes.
- The `_idempotency` TTL index (`idx_ttl`) and `idx_recordId` are never created.
- `scheduleIndexSetup` retries every 30 s with the same result and logs only a warning.

Without the TTL index, `_idempotency` entries, which hold full response bodies including personal data, are never expired by Mongo. `begin` ignores them after 24 h but does not delete them, which defeats the 24 h retention the README promises. Without `idx_recordId`, `removeForRecord` does a collection scan.

**Fix:** Make the name collision-free and keep one failure from blocking the rest.
```ts
// reject at config time, in indexIssues(): two paths that normalise to the same name
//   report({ code: "collection.INDEX_NAME_CLASH", at });
// and/or derive the name from the path without lossy replacement:
name: `idx_${path.replaceAll(".", "__")}`, // still collidable if a field contains "__"; prefer a hash or the raw path
// and in ensureIndexes: create `_idempotency` indexes first, and collect per-collection errors
// so one bad collection does not stop the others.
```

### WR-02: Valid `nextCursor` produces `bad_cursor` for integer sort values above 2^53

**File:** `src/collections/list-query.ts:161-162` (also `routes.ts` list handler that emits the cursor)
**Issue:** Ajv's `integer` accepts any JSON number with `n % 1 === 0`, for example `100000000000000000000` (parsed as 1e20). The list handler encodes that value into `nextCursor`. `cursorValueOk("integer", v)` requires `Number.isSafeInteger(v)`, so the server rejects its own cursor with 400 on the next page. Pagination is then permanently broken for a collection holding such a value, when sorting by that field. `TYPING.integer` (line 117) applies the same bound to filters, so such values can be stored but never filtered on or paged past.

**Fix:** Either require a bounded integer at config time (`INDEX_UNBOUNDED_INTEGER` unless `minimum` and `maximum` are within the safe range), or relax the cursor check to what the server can emit:
```ts
case "integer":
	return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
```

### WR-03: `If-Match` is silently ignored on `DELETE`

**File:** `src/collections/routes.ts:374-385`
**Issue:** `If-Match` is honoured on PUT and PATCH, and the README states that it is "send it back as `If-Match` on `PUT` or `PATCH`". The `DELETE` handler ignores it. RFC 9110 §13.1.1 says a recipient that does not evaluate a precondition on a method it handles is not conforming. A client that sends `If-Match: "3"` on `DELETE` to avoid deleting a record someone else updated gets an unconditional hard delete, which is irreversible (D-13). The OpenAPI document also omits the header for delete, so it is not self-documenting.

**Fix:** Either evaluate it (a conditional `deleteOne({ _id, _v: { $in: versions } })` and the same 404/412 disambiguation as replace), or reject a request that carries `If-Match` on `DELETE` with 412 or 400 instead of ignoring it. Document the chosen behaviour in README and OpenAPI.

### WR-04: `unboundedStrings` can be bypassed by a schema node with no `type`

**File:** `src/collections/definition.ts:231-253`
**Issue:** `allowsString` is true only when `type` is `"string"` or an array containing it. A property schema such as `{}`, `{ format: "email" }` or `{ pattern: "^a" }` has no `type`, so it accepts strings of any length (and any other JSON type). It is not flagged `UNBOUNDED_STRING`, yet the README and config comment promise that every string of an anonymously writable collection has a `maxLength`. The body limit still caps the total (default 16 KiB, at most 1 MiB), so this is a hardening gap rather than unbounded growth. It does let a deployer believe SEC-03 is enforced when it is not.

**Fix:** Treat a node with no `type` (and no `enum`/`const`/`$ref`/combinator that constrains it) as allowing strings:
```ts
function allowsString(node: Record<string, unknown>): boolean {
	const { type } = node;
	if (type === undefined) return !hasOwnConstraint(node); // enum, const, $ref, anyOf, oneOf, allOf, not
	return type === "string" || (Array.isArray(type) && type.includes("string"));
}
```

### WR-05: Kong reference config throttles authenticated writes at the anonymous-create limit

**File:** `deploy/kong.yml:35-40, 62-80`
**Issue:** Route `collections-write` matches every `POST /v1`. The 10-per-minute-per-IP limit and the 64 KB payload cap therefore also apply to API-key `POST`s, such as a website backend creating records through one egress IP. They also apply to collections that set `bodyLimit` above 64 KB (the schema allows up to 1 MiB). Those requests get a `429` or `413` from Kong that the API never produces, and the README's own status table does not explain them. The README presents this file as the recommended pairing, so a default deployment will hit this.

**Fix:** Split the route by `Authorization` header presence. For example, add a `headers: { authorization: ["~*^bearer "] }` route for authenticated writes under the looser limit, and keep the strict plugins on the headerless route. At minimum, document in the file header and the README that the limits cover all `POST`s and that the payload cap must be at least the largest `bodyLimit`.

## Info

### IN-01: Rate limit buckets are per exact IP, so IPv6 clients can rotate within a /64

**File:** `src/collections/hardening.ts:30-33`
**Issue:** `app.rateLimit({ max, timeWindow })` uses `request.ip` as the key. A single IPv6 subscriber typically controls a /64 and can present 2^64 distinct source addresses, so the per-IP anonymous limit is trivially avoided on IPv6. The honeypot, body limit and Kong remain.
**Fix:** Provide a `keyGenerator` that masks IPv6 addresses to /64, and note the in-memory, per-process store in the README for multi-replica deployments.

### IN-02: Duplicated TTL constant can drift

**File:** `src/collections/indexes.ts:26` and `src/collections/idempotency.ts:5`
**Issue:** `expireAfterSeconds: 86400` repeats `ENTRY_TTL_MS = 24 * 3600_000`. If one changes, Mongo expiry and `begin`'s own expiry disagree.
**Fix:** `expireAfterSeconds: ENTRY_TTL_MS / 1000`, importing the constant.

### IN-03: Authenticated and personal-data responses carry no `Cache-Control`

**File:** `src/collections/routes.ts` (list, get, replace, patch and create handlers)
**Issue:** Record responses (personal data) set `ETag` but no `Cache-Control`. Browsers and intermediaries may heuristically cache `GET` responses. Kong in front does not cache by default, but a different gateway might.
**Fix:** `reply.header("cache-control", "no-store")` in the shared reject/send helpers and the GET/list handlers.

### IN-04: Nested free-form objects are not subject to the property-name check

**File:** `src/collections/definition.ts:196-224`
**Issue:** `walk` checks `unsafeName` only for names declared under `properties`. A nested `{ "type": "object" }` with no `properties` and no `additionalProperties: false` is accepted (`NOT_CLOSED` requires `properties` to be present). An anonymous caller can then store keys beginning with `$` or containing `.` under `data`. Modern MongoDB accepts these in nested documents, but MongoDB below 5.0 returns a 500. Anonymous callers can also choose arbitrary nesting and key counts within the body limit.
**Fix:** Report `NOT_CLOSED` for any object-typed subschema without `additionalProperties: false`, or document that free-form objects are allowed and require MongoDB 5.0 or later.

### IN-05: Type assertions silence the swagger plugin options

**File:** `src/http/docs.ts:477-491`
**Issue:** The plugin options are passed as `as never`, and `transformObject` casts `openapiObject` and `components`. Typos in the options or a plugin upgrade changing the signature would not be caught by `tsc`. The suppression is unlabelled.
**Fix:** Type the options against `SwaggerOptions` (or the exported plugin option type) and narrow the casts to the single known mismatch, with a comment naming it.

### IN-06: `If-Match` on a missing record with `*` answers 404 where RFC 9110 expects 412

**File:** `src/collections/routes.ts:310-312`
**Issue:** For `PUT` with `If-Match: *` on a non-existent id the handler returns 404. RFC 9110 §13.1.1 says `*` fails the precondition when there is no current representation, so 412. This is a deliberate, harmless simplification (no upsert), but it is undocumented.
**Fix:** Note in README that a missing record is always 404, including with `If-Match`.

---

_Reviewed: 2026-11-22T12:30:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
