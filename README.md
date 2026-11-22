# mailbox-org-drive-rest-api

A self-hostable REST API that puts a **mailbox.org Drive** (or another WebDAV store) behind clean JSON endpoints:

- **Collections** — create, read, update and delete JSON records, validated against a JSON Schema, stored in MongoDB and mirrored to `.xlsx` workbooks on the Drive so people can open them in a spreadsheet.
- **Sheets** — expose an `.xlsx` file kept on the Drive as read-only JSON (for example a list of articles that staff edit by hand).
- **Documents** — serve `.docx` files from the Drive as Markdown.
- **Files** — list and download files from allow-listed Drive folders.
- *Later:* an S3-compatible object API for larger files.

> **Unofficial project.** Not affiliated with, endorsed by or supported by mailbox.org / Heinlein Support GmbH or Open-Xchange. "mailbox.org" is used only to describe compatibility.

> **Status: pre-alpha.** Collections with API keys and hardened anonymous form submission work; the `.xlsx` mirror, sheets, documents and files below are still planned. Anything marked planned may change. Planning artefacts live in [`.planning/`](.planning/).

---

## Why

Small organisations that already pay for a privacy-respecting mailbox.org account have Drive storage that staff use every day. This project lets a website or internal tool use that same storage:

- form submissions land in a spreadsheet staff can open, without anyone running a CMS;
- content that staff edit in Drive (spreadsheets, Word documents) can be published through an API;
- data stays with the organisation's existing provider.

The API is **generic**: nothing in this repository is specific to any one organisation. Each deployment describes its own collections, folders and access rules in a config file.

## Architecture

```mermaid
flowchart LR
  C[Clients<br/>website, internal tools] --> G[API gateway<br/>e.g. Kong: rate limits]
  I[OIDC provider<br/>e.g. Keycloak] -. tokens .-> C
  G --> A[mailbox-org-drive-rest-api]
  A <--> M[(MongoDB<br/>system of record + cache)]
  A <-->|WebDAV| D[(mailbox.org Drive)]
```

| Data | Source of truth | Direction |
|------|-----------------|-----------|
| Collection records (e.g. form responses) | MongoDB | API writes to MongoDB, then a single background writer regenerates the `.xlsx` mirror on the Drive. The mirror is **read-only for people**. |
| Sheets (e.g. a newsfeed index) | Drive `.xlsx` | Staff edit on the Drive; the API reads and caches it in MongoDB, refreshing when the file's ETag changes. |
| Documents (`.docx`) | Drive | Staff edit on the Drive; the API converts to Markdown on request and caches the result per file version. |
| Files | Drive | Read-only passthrough from allow-listed folders. |

Why MongoDB in front of the Drive: WebDAV has no transactions, so two writers updating one workbook can silently lose a record, and reading the Drive on every request is slow. MongoDB keeps writes safe and reads fast; the Drive stays the place people work.

## Concepts (planned)

- **Mount** — a named, allow-listed folder on the Drive, with `read` or `read-write` mode. The API can never reach outside its mounts.
- **Collection** — a named set of JSON records with a JSON Schema, an access policy and an optional `.xlsx` mirror on a mount.
- **Sheet** — a named `.xlsx` file (and worksheet) on a mount, exposed as JSON rows.
- **Access policy** — per collection and per operation: `anonymous`, `apiKey` or `oidc` (OIDC arrives in a later milestone).

### Example configuration

A complete, loadable example with every collection key is [`config/config.example.yaml`](config/config.example.yaml). In short:

```yaml
storage:
  webdav:
    url: ${WEBDAV_URL}
    username: ${WEBDAV_USERNAME}
    password: ${WEBDAV_APP_PASSWORD}

mongo:
  uri: ${MONGO_URI}

mounts:
  forms:   { path: "/Userstore/Example Service/forms",   mode: read-write }
  content: { path: "/Userstore/Example Service/content", mode: read }

collections:
  contact:
    schema: { $ref: contact.schema.json }   # or an inline JSON Schema
    operations: { create: anonymous, list: apiKey, get: apiKey, delete: apiKey }
    indexes: [topic]                        # fields list may filter and sort on
    honeypot: website                       # hidden form field that only bots fill
    cors: { origins: ["https://www.example.org"] }
    rateLimit: { max: 10, windowSeconds: 60 }
    bodyLimit: 16384

apiKeys:
  - name: website-backend
    hash: "<output of pnpm keygen>"
    grants: ["contact:list", "contact:get", "contact:delete"]
```

The `.xlsx` mirror of a collection and the sheets, documents and files endpoints are planned for later phases and are not in the config yet:

```
GET /v1/sheets/{sheet}                 (planned)
GET /v1/documents/{mount}/{path}.md    (planned)
GET /v1/files/{mount}/{path}           (planned)
```

## Collections

A collection is a set of JSON records defined entirely in config. Startup fails, with every problem listed at once, if a definition is invalid. Each operation has a policy, `anonymous` or `apiKey`; an operation that is not listed does not exist and answers `404`.

> **Warning: `get: anonymous` or `list: anonymous` exposes every record to anyone who can reach the API.** Records from a contact form are personal data. Use `anonymous` for `create` only, unless the records are meant to be public.

### Routes

| Operation | Route | Success |
|-----------|-------|---------|
| `create` | `POST /v1/{name}` | `201`, `ETag` |
| `list` | `GET /v1/{name}` | `200`, `{ items, nextCursor }` |
| `get` | `GET /v1/{name}/{id}` | `200`, `ETag` |
| `replace` | `PUT /v1/{name}/{id}` | `200`, `ETag` |
| `patch` | `PATCH /v1/{name}/{id}` (`application/merge-patch+json`) | `200`, `ETag` |
| `delete` | `DELETE /v1/{name}/{id}` | `204` |

A record is `{ ...your fields, id, createdAt, updatedAt }`. The `id` is a server-generated UUID. An anonymous `create` answers only `{ id, createdAt }`, so a visitor never sees fields they did not send. Bodies must be `application/json`; every body is validated against the collection's JSON Schema and is never coerced, stripped or defaulted. `PUT` replaces the whole record; `PATCH` applies an RFC 7396 merge patch and validates the merged result.

### Status codes

Every error is `application/problem+json` with fixed text. A `400` lists JSON Schema keywords and pointers to declared fields, never a submitted value.

| Status | When |
|--------|------|
| `400` | The body or the list query is invalid |
| `401` | A key is required and missing or unknown |
| `403` | The key lacks the grant (`<collection>:<operation>`), or the `Origin` is not on the collection's `cors.origins` |
| `404` | No such record, route or operation |
| `409` | An `Idempotency-Key` request is still in flight, or a `PATCH` kept losing a race with another writer |
| `412` | `If-Match` does not match the record's current version |
| `413` | The body is over the collection's `bodyLimit` |
| `415` | The `Content-Type` is not the one the operation takes |
| `422` | An `Idempotency-Key` was used before with another body or another API key |
| `429` | The per-IP rate limit of an anonymous operation is spent; see `Retry-After` |

### List, filters and paging

`GET /v1/{name}` returns `{ items, nextCursor }`, newest first.

- Filter on `createdAt`, `updatedAt` and the fields in `indexes`: `?topic=billing`, or a range with `.gt`, `.gte`, `.lt`, `.lte`: `?createdAt.gte=2026-11-01`. Dates are ISO 8601, a day or a date-time with a zone. A key may appear once.
- Order with `sort=topic` or `sort=-createdAt` (the default). Only the filterable fields can be sorted on.
- Page with `limit` (1 to 200, default 50) and `cursor`: pass the previous `nextCursor` until it is `null`. A cursor only works with the sort it came from.
- An unknown parameter, a filter on a field that is not indexed, or a malformed value gives `400`.

### If-Match

A `create`, `get`, `replace` or `patch` response sets an `ETag` holding the record's version, such as `"3"`. Send it back as `If-Match` on `PUT` or `PATCH` to change the record only if nobody else has: a stale version gives `412` and changes nothing. `If-Match: *` matches any existing record. A weak, unquoted or malformed value never matches, so it gives `412` rather than overwriting. Without the header, a `PUT` is last-writer-wins.

### Idempotency-Key

Send an `Idempotency-Key` header (1 to 255 visible ASCII characters, for example a random UUID) on `POST` so a retry after a timeout cannot store a record twice:

- the same key and body returns the original status, `ETag` and body, and stores nothing new;
- the same key with another body, or from another API key, gives `422`;
- a retry while the first request is still running gives `409`; try again in a moment;
- keys are scoped to a collection and kept for 24 hours; deleting a record also deletes the key entry that holds its data;
- the key is stored only as a hash and is never logged.

The header is ignored on every other operation.

### Honeypot

Add a hidden field to the form (`display: none`, no autocomplete) and name it in `honeypot`. People never fill it; bots do. A submission with that field filled gets a normal-looking `201` with a made-up `id` and nothing is stored. An empty value is accepted and dropped. The field must not appear in the schema.

### API keys

```sh
pnpm keygen              # in the container image: node dist/keygen.js
# key: mdra_...          give to the caller, shown once, stored nowhere
# hash: 3f9a...          paste into apiKeys[].hash in the config
```

Callers send `Authorization: Bearer <key>`. Only the SHA-256 hash is in the config, compared in constant time. List two entries in `apiKeys` while rotating, then remove the old one. Grants are exact `<collection>:<operation>` pairs without wildcards, and an operation with no grant is denied.

### OpenAPI document and UI

Set `server.docs: true` to serve an OpenAPI 3.1 document at `/docs/json` and an interactive UI at `/docs`. The document is generated from the config, so it lists exactly the collections and operations this deployment allows, with each collection's schema, the `Idempotency-Key` and `If-Match` headers and the problem responses. The UI's assets are served by the API itself; nothing loads from a CDN.

It is **off by default**: the document reveals collection names and schemas to anyone who can reach `/docs`. Turn it on for development, or in production restrict the `docs` route at the gateway (see [`deploy/kong.yml`](deploy/kong.yml)).

## Security model

- **Use a dedicated Drive account for the API.** A WebDAV app password unlocks that account's whole Drive, so the API should run as its own account. People share only the folders it needs into that account. Sensitive material never lives in it.
- **Mounts are allow-lists**; paths are normalised and checked to block path traversal.
- **Anonymous endpoints** (e.g. public form submission) rely on schema validation, payload size and content-type limits, a honeypot field, a per-IP rate limit, a CORS allow-list and the gateway. See [Anonymous form submission](#anonymous-form-submission).
- **Secrets** come from environment variables or a secret store, never from the repository.
- **Personal data:** collection records may be personal data under the GDPR. Deployers are responsible for a lawful basis, retention and a data processing agreement with their storage provider (for mailbox.org, Heinlein Support GmbH offers one under Art. 28 GDPR).

### Anonymous form submission

The API does **not** verify CAPTCHAs. That is the caller's job. If a form needs one, the website's own backend checks it (for example with a Turnstile, hCaptcha or reCAPTCHA-style `siteverify` call) and then creates the record with an `apiKey` create, instead of letting the browser post anonymously.

An anonymous create endpoint is protected by:

- strict schema validation (no coercion, no extra properties, required `maxLength` on strings);
- a body size limit and a `Content-Type: application/json` requirement;
- a honeypot field: a submission that fills it is silently discarded;
- a per-IP rate limit inside the API;
- a CORS allow-list of origins per collection;
- the gateway in front (see below).

### Gateway (Kong)

The API works without a gateway. If you run Kong, [`deploy/kong.yml`](deploy/kong.yml) is a reference DB-less config (tested with `kong:3.9.5`). It routes `/v1`, `/health`, `/ready` and `/docs` to the API, rate-limits per client IP (stricter on anonymous-capable `POST /v1` routes), caps the body size on those routes, and logs one JSON line per request with only the method, route name and status. The limits are examples; tune them.

Run Kong with these settings (also listed at the top of the file):

```sh
docker run -d --name kong \
  -e KONG_DATABASE=off \
  -e KONG_DECLARATIVE_CONFIG=/etc/kong/kong.yml \
  -e KONG_PROXY_ACCESS_LOG=off \
  -e KONG_ADMIN_LISTEN=off \
  -e KONG_ANONYMOUS_REPORTS=off \
  -v "$PWD/deploy/kong.yml:/etc/kong/kong.yml:ro" \
  -p 8000:8000 \
  kong:3.9.5
```

- `KONG_PROXY_ACCESS_LOG=off` is required: Kong's nginx access log writes the raw request line, including the query string, which can hold personal data.
- The config expects the API at `http://api:3000`; change the service URL to match your network.

**Pair Kong with `server.trustProxy`.** Behind Kong every request reaches the API from Kong's address, so the API's per-IP rate limit would put all clients in one bucket. Set `server.trustProxy` to Kong's address or CIDR, and nothing else: it does not restrict who may call the API, it only decides whose `X-Forwarded-For` header is believed. A header from any other peer is ignored, so a client cannot forge its IP.

`deploy/kong-check.sh` is a behavioural check (needs Docker and Node; not part of CI). It asks Kong to parse the file, then starts Kong against a stub upstream, sends a request with a canary string in the path, query, a header and the body, and fails if any Kong log line contains the canary or the client address. It also checks that the per-IP limit returns `429`.

```sh
bash deploy/kong-check.sh
```

### GDPR erasure (planned)

Overwriting a file on the Drive keeps its old versions, and deleted files go to the Drive trash. So an erasure is **not** simply "delete the record and regenerate the spreadsheet". The planned procedure:

1. Hard-delete the record in MongoDB.
2. **Delete** the `.xlsx` mirror (never overwrite it).
3. Purge it from the trash and remove its old versions. This probably uses the Open-Xchange HTTP API, because plain WebDAV may not reach the trash; otherwise it becomes a documented manual step.
4. Regenerate a fresh mirror with no version history.
5. Record the erased ID so the erasure is applied again if a database backup is restored.

Copies people have downloaded, and database backups, are outside the API's reach and belong in the deployer's own procedures.

## Tech stack (planned)

Node.js (LTS) · TypeScript · Fastify · JSON Schema (Ajv/TypeBox) · MongoDB · `webdav` client · `exceljs` · `mammoth` + `turndown` (`.docx` → HTML → Markdown) · Vitest · Docker Compose for local development (MongoDB plus a local WebDAV server, so tests never touch a real Drive).

## Local development

Prerequisites: Node 26 and Docker with Compose v2.

```sh
npm install -g pnpm@12.21.0   # the version pinned in package.json
pnpm install                  # install dependencies
pnpm stack:up                 # start MongoDB and a local WebDAV server
pnpm test                     # unit tests
pnpm test:integration         # integration tests against the local stack
pnpm lint                     # Biome lint and format check
pnpm typecheck                # tsc --noEmit
pnpm build                    # compile to dist/
pnpm stack:down               # stop the stack and discard its data
```

- Tests never touch a real Drive; they run against the local WebDAV server from the Compose stack.
- Fixtures hold synthetic data only.

## Roadmap

1. **Foundation** — service skeleton, config loading, WebDAV storage adapter, MongoDB, health check, CI, local dev stack.
2. **Collections** — JSON CRUD with schema validation, access policies (anonymous / API key), `.xlsx` mirror worker, reference gateway config with rate limits.
3. **Read-only content** — sheets as JSON, file listing and download, `.docx` → Markdown, caching keyed on ETags.
4. **OIDC and erasure** — validate tokens from an OIDC provider such as Keycloak; role-based access per collection; a GDPR erasure endpoint.
5. **Object storage** — an S3-compatible API for larger files (evaluate an `rclone serve s3` sidecar against a native subset).

## Compatibility and provider notes

The Drive adapter targets the WebDAV endpoint of mailbox.org Drive, which is built on Open-Xchange App Suite. It should work with other WebDAV servers, but only mailbox.org is a target for testing.

Things to know about mailbox.org as a backend (as of November 2026):

- **No published WebDAV rate limits**, and no official support for third-party integrations. The client is deliberately gentle: few requests in flight at once, exponential backoff on `429`/`503`, and reads served from cache rather than from the Drive.
- **No webhooks.** Changes on the Drive are detected by checking ETags on a configurable interval.
- **The terms of service** say nothing about automated WebDAV access. They do let the provider end a contract on two weeks' notice. Because MongoDB is the system of record and storage sits behind an adapter interface, a deployment can move to another backend.
- **WebDAV credentials:** if two-factor authentication is on, use an application password.

## Contributing

Not open for contributions yet. Issues and design feedback are welcome once the first milestone is published.

**Never commit real personal data, credentials or production config.** Use the synthetic fixtures in `test/fixtures/`.

## Licence

Licensed under the [European Union Public Licence v1.2](LICENSE) (EUPL-1.2).
