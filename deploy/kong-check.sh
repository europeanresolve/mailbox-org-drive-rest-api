#!/usr/bin/env bash
# Behavioural check of deploy/kong.yml (SEC-09). Requires Docker and Node.
#
# 1. Asks Kong itself to parse the file (`kong config parse`).
# 2. Starts a stub upstream on 127.0.0.1:3000 that answers 201 to everything.
# 3. Starts Kong from the file, sends one POST that carries a canary in the path,
#    query, a header and the body, and proves:
#      - no Kong log line contains the canary or the client address;
#      - one JSON line records method POST, route collections-write, status 201.
# 4. Sends POSTs until Kong answers 429 and fails if none arrives by request 11.
#
# Synthetic data only. Not part of CI (Kong is a reference artefact).
#
# On Linux Docker Engine, `host-gateway` is the bridge address, which cannot reach
# a loopback-only stub: run with STUB_BIND=0.0.0.0 there.
set -euo pipefail

KONG_IMAGE="kong:3.9.5"
STUB_BIND="${STUB_BIND:-127.0.0.1}"
STUB_PORT=3000
CANARY="CANARY-7f3a"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workdir="$(mktemp -d)"
container="kong-check-$$"
stub_pid=""

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  if [ -n "$stub_pid" ]; then kill "$stub_pid" >/dev/null 2>&1 || true; fi
  rm -rf "$workdir"
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

kong_env=(
  -e KONG_DATABASE=off
  -e KONG_DECLARATIVE_CONFIG=/etc/kong/kong.yml
  -e KONG_PROXY_ACCESS_LOG=off
  -e KONG_ADMIN_LISTEN=off
  -e KONG_ANONYMOUS_REPORTS=off
  -e KONG_PROXY_LISTEN=0.0.0.0:8000
)

echo "== 1. kong config parse ($KONG_IMAGE)"
docker run --rm "${kong_env[@]}" \
  -v "$here/kong.yml:/etc/kong/kong.yml:ro" \
  "$KONG_IMAGE" kong config parse /etc/kong/kong.yml >/dev/null \
  || fail "Kong rejected deploy/kong.yml"
echo "ok: Kong accepts the file"

echo "== 2. stub upstream on $STUB_BIND:$STUB_PORT"
# Answers 201 to any request and records the X-Forwarded-For Kong sets, which is
# the client address Kong saw (used below to prove it is not logged).
cat >"$workdir/stub.mjs" <<'JS'
import http from "node:http";
import fs from "node:fs";
const [bind, port, out] = process.argv.slice(2);
http
  .createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      fs.appendFileSync(out, `${req.headers["x-forwarded-for"] ?? ""}\n`);
      res.writeHead(201, { "content-type": "application/json" });
      res.end("{}");
    });
  })
  .listen(Number(port), bind);
JS
node "$workdir/stub.mjs" "$STUB_BIND" "$STUB_PORT" "$workdir/xff.txt" &
stub_pid=$!
sleep 1
kill -0 "$stub_pid" 2>/dev/null || fail "stub upstream could not start (is port $STUB_PORT in use?)"

echo "== 3. start Kong"
docker run -d --name "$container" "${kong_env[@]}" \
  -v "$here/kong.yml:/etc/kong/kong.yml:ro" \
  --add-host api:host-gateway \
  -p 127.0.0.1::8000 \
  "$KONG_IMAGE" >/dev/null
proxy="127.0.0.1:$(docker port "$container" 8000/tcp | head -n1 | sed 's/.*://')"

ready=0
for _ in $(seq 1 60); do
  # Any HTTP answer (even 404) means the proxy is up. Hits /nope: no route, no limit used.
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://$proxy/nope" || true)" = "404" ]; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { docker logs "$container" >&2 || true; fail "Kong proxy did not come up"; }

# Kong's local rate limit uses fixed one-minute windows aligned to the clock.
# Avoid starting the 11-request burst near a minute boundary, or it could be split
# across two windows and never reach 429.
sec=$((10#$(date -u +%S)))
if [ "$sec" -ge 45 ]; then
  echo "waiting for the next minute window"
  sleep $((62 - sec))
fi

echo "== 4. canary request"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "http://$proxy/v1/contact-$CANARY?email=$CANARY@example.invalid" \
  -H "X-Canary: $CANARY" -H 'content-type: application/json' \
  -d "{\"name\":\"$CANARY\",\"email\":\"$CANARY@example.invalid\"}")"
[ "$code" = "201" ] || { docker logs "$container" >&2 || true; fail "canary POST returned $code, expected 201 from the stub"; }

client_addr="$(head -n1 "$workdir/xff.txt" | cut -d, -f1 | tr -d ' ')"
[ -n "$client_addr" ] || fail "could not learn the client address (no X-Forwarded-For at the stub)"

# file-log writes asynchronously: wait for the line.
logs=""
for _ in $(seq 1 20); do
  logs="$(docker logs "$container" 2>&1 || true)"
  if grep -q '"route"' <<<"$logs"; then break; fi
  sleep 0.5
done

if grep -qi "canary-7f3a" <<<"$logs"; then
  echo "$logs" >&2
  fail "a Kong log line contains the canary"
fi
if grep -qF "$client_addr" <<<"$logs"; then
  echo "$logs" >&2
  fail "a Kong log line contains the client address ($client_addr)"
fi

# Exactly one JSON line must record method, route name and status.
printf '%s\n' "$logs" | node -e '
  const lines = require("node:fs").readFileSync(0, "utf8").split("\n");
  const hit = lines.filter((l) => {
    try {
      const j = JSON.parse(l);
      return j.method === "POST" && j.route === "collections-write" && j.status === 201;
    } catch {
      return false;
    }
  });
  if (hit.length !== 1) {
    console.error(`FAIL: expected 1 JSON log line with POST/collections-write/201, found ${hit.length}`);
    process.exit(1);
  }
  const forbidden = ["request", "response", "client_ip", "upstream_uri", "tries", "service", "consumer"];
  const bad = forbidden.filter((k) => k in JSON.parse(hit[0]));
  if (bad.length) {
    console.error(`FAIL: log line still carries: ${bad.join(", ")}`);
    process.exit(1);
  }
  console.log("ok: log line " + hit[0]);
'
echo "ok: no canary and no client address in Kong logs"

echo "== 5. rate limit"
got429=0
# Request 1 was the canary POST; the limit is 10 per minute, so request 11 is the first 429.
for n in $(seq 2 11); do
  c="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://$proxy/v1/contact" \
    -H 'content-type: application/json' -d '{}')"
  if [ "$c" = "429" ]; then
    got429=$n
    break
  fi
done
[ "$got429" != 0 ] || fail "no 429 by request 11"
[ "$got429" = 11 ] || fail "first 429 arrived at request $got429, expected 11 (limit is 10 per minute)"
echo "ok: request $got429 was the first 429"

echo "PASS: deploy/kong.yml parses, keeps request data out of logs and rate-limits"
