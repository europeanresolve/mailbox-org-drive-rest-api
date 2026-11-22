# mailbox-org-drive-rest-api

A self-hostable REST API that puts a **mailbox.org Drive** (or another WebDAV store) behind clean JSON endpoints:

- **Collections** — create, read, update and delete JSON records, validated against a JSON Schema, stored in MongoDB and mirrored to `.xlsx` workbooks on the Drive so people can open them in a spreadsheet.
- **Sheets** — expose an `.xlsx` file kept on the Drive as read-only JSON (for example a list of articles that staff edit by hand).
- **Documents** — serve `.docx` files from the Drive as Markdown.
- **Files** — list and download files from allow-listed Drive folders.
- *Later:* an S3-compatible object API for larger files.

> **Unofficial project.** Not affiliated with, endorsed by or supported by mailbox.org / Heinlein Support GmbH or Open-Xchange. "mailbox.org" is used only to describe compatibility.

> **Status: pre-alpha / planning.** Nothing here is usable yet. Everything below describes the intended design and may change. Planning artefacts live in [`.planning/`](.planning/).

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

### Example configuration (illustrative only)

```yaml
storage:
  webdav:
    url: https://dav.mailbox.org/servlet/webdav.infostore/
    username: ${WEBDAV_USERNAME}
    password: ${WEBDAV_APP_PASSWORD}

mounts:
  forms:   { path: "/Userstore/Example Service/forms",   mode: read-write }
  content: { path: "/Userstore/Example Service/content", mode: read }

collections:
  contact:
    schema: ./schemas/contact.schema.json
    access: { create: anonymous, read: apiKey, update: apiKey, delete: apiKey }
    mirror: { mount: forms, path: contact/responses.xlsx }

sheets:
  articles: { mount: content, path: articles.xlsx, worksheet: Articles }
```

### Endpoint sketch (planned, v1)

```
GET    /health
POST   /v1/collections/{collection}/records
GET    /v1/collections/{collection}/records
GET    /v1/collections/{collection}/records/{id}
PUT    /v1/collections/{collection}/records/{id}
PATCH  /v1/collections/{collection}/records/{id}
DELETE /v1/collections/{collection}/records/{id}
GET    /v1/sheets/{sheet}
GET    /v1/documents/{mount}/{path}.md
GET    /v1/files/{mount}/{path}
```

An OpenAPI description will be generated from the code and served at `/docs`.

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
