#!/usr/bin/env bash
# Apply the latest code. There's no build step: the launchd agent runs
# `node server.js` and loads the code once at startup, so "updating" means
# restarting the agent so it re-reads server.js (and everything it imports)
# from disk. Needs no sudo — the agent is a per-user LaunchAgent.
#
# Usage: ./scripts/update.sh [--kill-strays]
#   --kill-strays  also stop any manually-started server.js instances that are
#                  listening on other ports (they'd keep serving stale code).
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.aaryan.tasklist"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-8787}"
KILL_STRAYS=0
[ "${1:-}" = "--kill-strays" ] && KILL_STRAYS=1

if [ ! -f "$PLIST" ]; then
  echo "ERROR: $PLIST not found — run ./setup.sh first." >&2
  exit 1
fi

# Restart the agent (re-execs from disk). kickstart -k is the clean path; fall
# back to unload/load on older launchd that lacks it.
if launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null; then
  echo "Restarted $LABEL."
else
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "Reloaded $LABEL."
fi

# Confirm it comes back up and is serving the new code.
ok=0
for _ in $(seq 1 12); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/status" 2>/dev/null; then
    ok=1; break
  fi
  sleep 0.5
done
if [ "$ok" = 1 ]; then
  echo "Serving latest code on http://127.0.0.1:$PORT"
else
  echo "WARNING: no response on :$PORT yet — check $DIR/logs/err.log" >&2
fi

# Flag (or with --kill-strays, stop) other server.js listeners on different
# ports — the kind that silently serve old code and cause confusion.
strays=""
while read -r pid lport; do
  [ -z "${pid:-}" ] && continue
  [ "$lport" = "$PORT" ] && continue
  case "$(ps -p "$pid" -o command= 2>/dev/null)" in
    *server.js*) strays="$strays $pid:$lport" ;;
  esac
done < <(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 && /node/ {n=split($9,a,":"); print $2, a[n]}')

if [ -n "$strays" ]; then
  if [ "$KILL_STRAYS" = 1 ]; then
    for s in $strays; do
      kill "${s%%:*}" 2>/dev/null && echo "Killed stray server.js ($s)."
    done
  else
    echo "Note: other server.js instance(s) listening on:$strays"
    echo "      Re-run './scripts/update.sh --kill-strays' to stop them."
  fi
fi
