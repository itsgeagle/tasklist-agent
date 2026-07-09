#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  echo "ERROR: node not found on PATH" >&2
  exit 1
fi
PORT="${PORT:-8787}"
PLIST="$HOME/Library/LaunchAgents/com.aaryan.tasklist.plist"

mkdir -p "$DIR/logs" "$DIR/data"

# 1. .env
if [ ! -f "$DIR/.env" ]; then
  cp "$DIR/.env.example" "$DIR/.env"
  echo "Created .env — fill in SLACK_USER_TOKEN and DISCORD_WEBHOOK_URL, then re-run."
fi

# 1b. CLAUDE_BIN — launchd's PATH is minimal, so resolve the absolute path to
# the `claude` binary now and pin it in .env; otherwise every scheduled run
# ENOENT-fails because the bare name "claude" isn't found.
CLAUDE_BIN_PATH="$(command -v claude || true)"
if [ -n "$CLAUDE_BIN_PATH" ]; then
  if grep -q '^CLAUDE_BIN=' "$DIR/.env" 2>/dev/null; then
    sed -i '' -e "s#^CLAUDE_BIN=.*#CLAUDE_BIN=$CLAUDE_BIN_PATH#" "$DIR/.env"
  else
    echo "CLAUDE_BIN=$CLAUDE_BIN_PATH" >> "$DIR/.env"
  fi
else
  echo "WARNING: 'claude' not found on PATH — set CLAUDE_BIN in .env manually." >&2
fi

# 2. hosts entry (idempotent)
if ! grep -q "[[:space:]]tasklist$" /etc/hosts; then
  echo "127.0.0.1 tasklist" | sudo tee -a /etc/hosts >/dev/null
  echo "Added 'tasklist' to /etc/hosts"
fi

# 3. pf redirect 80 -> PORT (idempotent anchor)
ANCHOR="/etc/pf.anchors/tasklist"
echo "rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port $PORT" | sudo tee "$ANCHOR" >/dev/null
if ! grep -q 'anchor "tasklist"' /etc/pf.conf; then
  echo 'anchor "tasklist"' | sudo tee -a /etc/pf.conf >/dev/null
  echo 'load anchor "tasklist" from "/etc/pf.anchors/tasklist"' | sudo tee -a /etc/pf.conf >/dev/null
fi
sudo pfctl -f /etc/pf.conf >/dev/null 2>&1 || true
sudo pfctl -e >/dev/null 2>&1 || true

# 4. launchd agent
# launchd runs services with a minimal PATH, so give it one that covers the
# common Homebrew/local-bin locations for `claude` and friends.
PATH_VAL="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
sed -e "s#__NODE__#$NODE#g" -e "s#__DIR__#$DIR#g" -e "s#__PATH__#$PATH_VAL#g" \
  "$DIR/scripts/tasklist.plist.template" > "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "Loaded launchd agent. Open http://tasklist (or http://tasklist:$PORT)."
