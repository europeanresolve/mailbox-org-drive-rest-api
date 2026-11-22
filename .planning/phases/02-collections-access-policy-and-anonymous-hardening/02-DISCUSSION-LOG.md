# Phase 2: Collections, Access Policy and Anonymous Hardening - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-11-22
**Phase:** 02-collections-access-policy-and-anonymous-hardening
**Areas discussed:** API keys, Delete semantics, Anonymous form behaviour, API surface & queries

---

## API keys

| Option | Description | Selected |
|--------|-------------|----------|
| Hashes in config.yaml | Name + SHA-256 hash, keygen command, restart to rotate, KeyStore interface | ✓ |
| MongoDB + admin endpoints | Rotation without restart; bootstrap admin key, more surface | |
| Plain keys via ${VAR}, hashed at startup | Simplest; plaintext in env | |

| Option | Description | Selected |
|--------|-------------|----------|
| Policy names allowed keys | `apiKey: [backoffice]` on each operation | |
| Global keys | Any key, any apiKey operation | |
| Grants listed on the key | `contact:list` style grants on each key | ✓ |

| Option | Description | Selected |
|--------|-------------|----------|
| Authorization: Bearer | Standard, redacted, prefixed keys | ✓ |
| X-API-Key | OpenAPI apiKey scheme | |
| Accept both | Two code paths | |

| Option | Description | Selected |
|--------|-------------|----------|
| Exact grants only | Unknown grant fails startup | ✓ |
| Allow `collection:*` | Per-collection wildcard | |
| Full wildcards | Admin-style key | |

**Key on anonymous route bypasses checks?** User (free text): "CAPTCHA will be enforced before it reaches this REST API. So we'd use the usual apiKey - one code path, nothing to probe".

**Follow-up, SEC-07:** options were keep it (optional, off by default), defer it, or drop it. **User chose: drop it entirely.**
**Follow-up, adopter anonymous use:** options were backend with key / both / undecided. **User chose: backend with key; anonymous stays generic.**

---

## Delete semantics

| Option | Description | Selected |
|--------|-------------|----------|
| Hard delete | Remove document; mirror regenerates | ✓ |
| Soft delete (tombstone) | `deletedAt`, purge later | |
| Per-collection config | Two behaviours | |

| Option | Description | Selected |
|--------|-------------|----------|
| 404 problem+json | Consistent with GET | ✓ |
| 204 always | Idempotent, no existence leak | |

---

## Anonymous form behaviour

| Question | Options | Selected |
|----------|---------|----------|
| Honeypot response | Fake 201 / 204 | Fake 201 |
| Idempotency | 24 h TTL, mismatch → 422 / configurable TTL / return original anyway | 24 h TTL, mismatch → 422 |
| trustProxy | CIDR list, default none / hop count / both | CIDR list, default none (after explanation) |
| Rate limit / Origin | Per-collection limit, Origin-less allowed / require Origin | Per-collection limit, Origin-less allowed |

**Notes:** On trustProxy, the user asked whether the API is still deployable anywhere and callable from front-ends. Claude explained that the setting only decides whose `X-Forwarded-For` is believed for per-IP rate limiting and does not restrict callers. The user then chose the CIDR list.

---

## API surface & queries

| Question | Options | Selected |
|----------|---------|----------|
| URL shape | /collections/{name} / /v1/collections/{name} / /{name} | Free text: `/v1/{name}[/{id}]`, shortest, with a version prefix so it doesn't clash with docs/health |
| Filter syntax | `field[gte]` / `field.gte` / JSON param | `field.gte` |
| Paging/sorting | Keyset on createdAt only / sort by any indexed field | Sort by any indexed field |
| Concurrency | Optional If-Match / required / none | Optional If-Match |
| Read-route namespace | Under /v1 with reserved names / root unversioned / underscore prefix | Under /v1 with reserved names |
| Indexed field depth | Top-level only / dotted paths | Dotted paths |

---

## Claude's Discretion

- Collection config layout, the list response envelope, `/docs` exposure, the maxLength enforcement rule, keygen form and key prefix, and the status codes not pinned by a decision.

## Deferred Ideas

- MongoDB-backed KeyStore with management endpoints.
- SEC-07 dropped (not deferred).
