#!/usr/bin/env bash
set -euo pipefail

CURL_BIN="${CURL_BIN:-/usr/bin/curl}"
PYTHON_BIN="${PYTHON_BIN:-/usr/bin/python3}"
LAVALINK_URL="${LAVALINK_URL:-http://127.0.0.1:2333}"
POT_PROVIDER_URL="${YOUTUBE_POT_PROVIDER_URL:-http://127.0.0.1:4416}"
SEED_URL="${YOUTUBE_POT_SEED_URL:-https://www.youtube.com/watch?v=jNQXAC9IVRw}"
ENV_FILE="${LAVALINK_ENV_FILE:-$(dirname "$0")/lavalink.env}"

if [[ ! -r "$ENV_FILE" ]]; then
  printf 'Lavalink environment file is not readable: %s\n' "$ENV_FILE" >&2
  exit 1
fi

lavalink_password="$($PYTHON_BIN - "$ENV_FILE" <<'PY'
import os
import sys

password = os.environ.get('LAVALINK_PASSWORD', '')
if not password:
    with open(sys.argv[1], encoding='utf-8') as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if line.startswith('LAVALINK_PASSWORD='):
                password = line.split('=', 1)[1]
                break
if not password:
    raise SystemExit('LAVALINK_PASSWORD is missing')
print(password)
PY
)"

visitor_data=''
for _attempt in {1..6}; do
  visitor_data="$($CURL_BIN -fsSL --max-time 25 \
    -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36' \
    "$SEED_URL" \
    | $PYTHON_BIN -c "import re,sys,urllib.parse; text=sys.stdin.read(); match=re.search(r'\\\"visitorData\\\":\\\"([^\\\"]+)\\\"', text); print(urllib.parse.unquote(match.group(1)) if match else '')")" || true
  [[ -n "$visitor_data" ]] && break
  sleep 5
done

if [[ -z "$visitor_data" ]]; then
  printf 'Failed to extract YouTube visitorData\n' >&2
  exit 1
fi

pot_request="$($PYTHON_BIN - "$visitor_data" <<'PY'
import json
import sys
print(json.dumps({'content_binding': sys.argv[1], 'context': 'gvs'}))
PY
)"
pot_response=''
for _attempt in {1..6}; do
  pot_response="$($CURL_BIN -fsS --max-time 45 -X POST \
    "$POT_PROVIDER_URL/get_pot" \
    -H 'Content-Type: application/json' \
    --data "$pot_request")" || true
  [[ -n "$pot_response" ]] && break
  sleep 5
done

if [[ -z "$pot_response" ]]; then
  printf 'POT provider did not return a response\n' >&2
  exit 1
fi

po_token="$($PYTHON_BIN -c "import json,sys; print(json.load(sys.stdin).get('poToken', ''))" <<<"$pot_response" 2>/dev/null)" || true

if [[ -z "$po_token" ]]; then
  printf 'POT provider did not return a poToken\n' >&2
  exit 1
fi

for _attempt in {1..60}; do
  status="$($CURL_BIN -sS --max-time 5 -o /dev/null -w '%{http_code}' \
    "$LAVALINK_URL/v4/info" \
    -H "Authorization: $lavalink_password" || true)"
  [[ "$status" == '200' ]] && break
  sleep 2
done

update_request="$($PYTHON_BIN - "$po_token" "$visitor_data" <<'PY'
import json
import sys
print(json.dumps({'poToken': sys.argv[1], 'visitorData': sys.argv[2]}))
PY
)"
status="$($CURL_BIN -sS --max-time 30 -o /dev/null -w '%{http_code}' -X POST \
  "$LAVALINK_URL/youtube" \
  -H "Authorization: $lavalink_password" \
  -H 'Content-Type: application/json' \
  --data "$update_request")"

if [[ "$status" != '204' ]]; then
  printf 'Lavalink rejected YouTube token refresh (HTTP %s)\n' "$status" >&2
  exit 1
fi

printf 'Lavalink YouTube poToken refreshed successfully\n'
