#!/usr/bin/env bash
# End-to-end smoke test: start server, exercise the API, kill server.
set -euo pipefail

PORT=18765
DATA=$(mktemp -d)
trap 'kill ${PID:-0} 2>/dev/null || true; rm -rf "$DATA"' EXIT

./snackpage serve --addr "127.0.0.1:${PORT}" --data-dir "$DATA" --log-level error &
PID=$!
sleep 0.3

base="http://127.0.0.1:${PORT}"
expect() {
  local label="$1"; shift
  local want="$1"; shift
  local got
  got=$("$@")
  if [[ "$got" == *"$want"* ]]; then
    echo "  ok: $label"
  else
    echo "  FAIL: $label"
    echo "    want substring: $want"
    echo "    got: $got"
    exit 1
  fi
}

echo "snackpage e2e"

expect "healthz returns ok" "ok" \
  curl -fsS "$base/healthz"

expect "initial bookmarks empty" '"bookmarks":[]' \
  curl -fsS "$base/api/bookmarks"

created=$(curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"title":"E2E","url":"https://example.com/e2e","tags":["test"]}' \
  "$base/api/bookmarks")
id=$(echo "$created" | sed -E 's/.*"id":"([^"]+)".*/\1/')

expect "created bookmark id is 8 crockford chars" "$id" \
  bash -c "echo $id | grep -E '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$'"

expect "redirect bumps visit count" "Location: https://example.com/e2e" \
  bash -c "curl -fsSI '$base/go/$id' | tr -d '\r'"

expect "list shows visit_count=1" '"visit_count":1' \
  curl -fsS "$base/api/bookmarks"

expect "delete returns 204" "204" \
  bash -c "curl -fsS -o /dev/null -w '%{http_code}' -X DELETE '$base/api/bookmarks/$id'"

expect "list empty after delete" '"bookmarks":[]' \
  curl -fsS "$base/api/bookmarks"

echo "snackpage e2e: ALL OK"
