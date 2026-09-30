#!/usr/bin/env bash
# tunnel.sh — expose this Abba instance through a Cloudflare quick tunnel,
# capture the public URL, and write it to .env as ABBA_PUBLIC_URL.
#
# Usage: ./tunnel.sh [abba-dir] [port]
#   abba-dir defaults to the directory this script lives in.
#   port defaults to 3013.
#
# The tunnel keeps running in the background:
#   pid: <abba-dir>/.tunnel.pid   log: <abba-dir>/.tunnel.log
# Stop it with: kill "$(cat .tunnel.pid)"
#
# After the URL is written, restart Abba so the mesh advertises the
# public address: bun src/server.ts   (Bun loads .env automatically)

set -euo pipefail

DIR="${1:-$(cd "$(dirname "$0")" && pwd)}"
PORT="${2:-3013}"
ENV_FILE="$DIR/.env"
PID_FILE="$DIR/.tunnel.pid"
LOG_FILE="$DIR/.tunnel.log"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found — install it first:" >&2
  echo "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
  exit 1
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "tunnel already running (pid $(cat "$PID_FILE"))"
else
  : > "$LOG_FILE"
  setsid nohup cloudflared tunnel --url "http://localhost:$PORT" >>"$LOG_FILE" 2>&1 < /dev/null &
  echo $! > "$PID_FILE"
  echo "started cloudflared (pid $!)"
fi

URL=""
for _ in $(seq 1 60); do
  # first trycloudflare.com URL that isn't the Cloudflare API endpoint
  # (the API URL appears in early log lines; the tunnel hostname comes later
  # in the "Your quick Tunnel has been created" banner)
  URL=$(grep -oE 'https://[A-Za-z0-9.-]+\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null \
    | grep -v '^https://api\.trycloudflare\.com$' | head -n 1 || true)
  [ -n "$URL" ] && break
  sleep 1
done

if [ -z "$URL" ]; then
  echo "timed out waiting for the tunnel URL — see $LOG_FILE" >&2
  exit 1
fi

touch "$ENV_FILE"
tmp=$(mktemp)
grep -v '^ABBA_PUBLIC_URL=' "$ENV_FILE" > "$tmp" || true
printf 'ABBA_PUBLIC_URL=%s\n' "$URL" >> "$tmp"
mv "$tmp" "$ENV_FILE"

echo "tunnel up: $URL"
echo "wrote ABBA_PUBLIC_URL to $ENV_FILE"
echo "restart abba to pick it up: bun src/server.ts"
