#!/usr/bin/env bash
# Keep the Mac from sleeping while the agent runs (a sleeping Mac freezes the VM, and with it any open
# positions' monitoring). Uses a LaunchAgent running `caffeinate`.
#
#   keep-awake.sh install | uninstall | status
#
# Note: closing a laptop lid still sleeps it unless it is on power with an external display.
set -euo pipefail
LABEL=com.ouroboros.keepawake
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
case "${1:-status}" in
  install)
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>-m</string><string>-s</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
PL
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "keep-awake installed: this Mac will not idle-sleep while logged in (on power)." ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"; echo "keep-awake removed." ;;
  status)
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then echo "keep-awake: active"; else echo "keep-awake: not installed"; fi ;;
  *) echo "usage: keep-awake.sh install|uninstall|status" >&2; exit 2 ;;
esac
