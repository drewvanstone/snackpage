#!/usr/bin/env bash
# End-to-end smoke test: start a fresh server, exercise the API, stop the exact
# child process we created, and preserve its log long enough to diagnose errors.
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BIN="$ROOT_DIR/snackpage"
DATA=$(mktemp -d "${TMPDIR:-/tmp}/snackpage-e2e.XXXXXX")
LOG="$DATA/server.log"
PID=""

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    for _ in {1..20}; do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$PID" 2>/dev/null || true
  fi
  if [[ -n "$PID" ]]; then
    wait "$PID" 2>/dev/null || true
  fi
  if [[ "$status" -ne 0 && -s "$LOG" ]]; then
    echo "server log:" >&2
    sed 's/^/  /' "$LOG" >&2
  fi
  rm -rf "$DATA"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

expect_contains() {
  local label=$1
  local want=$2
  local got=$3
  if [[ "$got" == *"$want"* ]]; then
    echo "  ok: $label"
    return
  fi
  echo "  FAIL: $label" >&2
  echo "    want substring: $want" >&2
  echo "    got: $got" >&2
  exit 1
}

expect_equal() {
  local label=$1
  local want=$2
  local got=$3
  if [[ "$got" == "$want" ]]; then
    echo "  ok: $label"
    return
  fi
  echo "  FAIL: $label" >&2
  echo "    want: $want" >&2
  echo "    got: $got" >&2
  exit 1
}

if [[ ! -x "$BIN" ]]; then
  echo "snackpage e2e: $BIN is missing; run make build first" >&2
  exit 1
fi

# Port zero asks the kernel for an unused port and keeps it reserved by this
# child listener, avoiding the release-and-rebind race of a separate port
# probe. SNACKPAGE_E2E_PORT remains available for debugging.
PORT=${SNACKPAGE_E2E_PORT:-0}
"$BIN" serve --addr "127.0.0.1:${PORT}" --data-dir "$DATA" --log-level info >"$LOG" 2>&1 &
PID=$!

ready=false
base=""
for _ in {1..100}; do
  if ! kill -0 "$PID" 2>/dev/null; then
    wait "$PID" || true
    echo "snackpage e2e: server exited before becoming healthy" >&2
    exit 1
  fi
  if [[ -z "$base" ]]; then
    listen_addr=$(sed -nE 's/.*msg=listening addr=([^ ]+).*/\1/p' "$LOG" | tail -n 1)
    if [[ -n "$listen_addr" ]]; then
      base="http://${listen_addr}"
    fi
  fi
  if [[ -n "$base" ]] && curl -fsS --max-time 0.5 "$base/healthz" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.1
done
if [[ "$ready" != true ]]; then
  echo "snackpage e2e: server did not become healthy within 10 seconds" >&2
  exit 1
fi

echo "snackpage e2e"

health=$(curl -fsS "$base/healthz")
expect_contains "healthz returns ok" "ok" "$health"

initial=$(curl -fsS "$base/api/bookmarks")
expect_contains "initial bookmarks empty" '"bookmarks":[]' "$initial"

created=$(curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"title":"E2E","url":"https://example.com/e2e","tags":["test"]}' \
  "$base/api/bookmarks")
id=$(sed -E 's/.*"id":"([^"]+)".*/\1/' <<<"$created")
if [[ "$id" =~ ^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$ ]]; then
  echo "  ok: created bookmark id is 8 Crockford characters"
else
  echo "  FAIL: invalid bookmark id in response: $created" >&2
  exit 1
fi

# Use a real GET: visits are navigation events, and HEAD must not be relied on
# to mutate state.
redirect=$(curl -fsS -o /dev/null -w '%{redirect_url}' "$base/go/$id")
expect_equal "GET redirect targets bookmark" "https://example.com/e2e" "$redirect"

visited=$(curl -fsS "$base/api/bookmarks")
expect_contains "GET redirect records one visit" '"visit_count":1' "$visited"

delete_status=$(curl -fsS -o /dev/null -w '%{http_code}' -X DELETE "$base/api/bookmarks/$id")
expect_equal "delete returns 204" "204" "$delete_status"

remaining=$(curl -fsS "$base/api/bookmarks")
expect_contains "list empty after delete" '"bookmarks":[]' "$remaining"

echo "snackpage e2e: ALL OK"
