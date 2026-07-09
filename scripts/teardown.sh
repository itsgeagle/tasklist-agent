#!/usr/bin/env bash
set -euo pipefail
PLIST="$HOME/Library/LaunchAgents/com.aaryan.tasklist.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
sudo sed -i '' '/[[:space:]]tasklist$/d' /etc/hosts || true
sudo sed -i '' '\#anchor "tasklist"#d' /etc/pf.conf || true
sudo sed -i '' '\#load anchor "tasklist"#d' /etc/pf.conf || true
sudo rm -f /etc/pf.anchors/tasklist || true
sudo pfctl -f /etc/pf.conf >/dev/null 2>&1 || true
echo "Removed tasklist launchd agent, hosts entry, and pf redirect."
