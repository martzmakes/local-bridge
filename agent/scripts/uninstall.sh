#!/bin/bash
# Stops and removes the Local Bridge LaunchAgent.
#
#   scripts/uninstall.sh           stop the agent, remove the plist
#   scripts/uninstall.sh --purge   also remove the installed bundle and the logs
#
# The config file and the Keychain items are never removed. To remove the
# device key by hand (the machine then has to be registered again):
#   security delete-generic-password -s com.martzmakes.local-bridge.device-key -a <machine>
set -euo pipefail

LABEL="com.martzmakes.local-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SUPPORT_DIR="$HOME/Library/Application Support/local-bridge"
LOG_DIR="$HOME/Library/Logs/local-bridge"
DOMAIN="gui/$(id -u)"

PURGE=0
case "${1:-}" in
  "") ;;
  --purge) PURGE=1 ;;
  *) echo "usage: $0 [--purge]" >&2; exit 2 ;;
esac

if launchctl print "$DOMAIN/$LABEL" > /dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" || true
  echo "Stopped $LABEL"
else
  echo "$LABEL is not loaded"
fi

if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  echo "Removed $PLIST"
fi

if [ "$PURGE" -eq 1 ]; then
  rm -rf "$SUPPORT_DIR" "$LOG_DIR"
  echo "Removed $SUPPORT_DIR and $LOG_DIR"
fi

echo "Left in place: ~/.config/local-bridge/config.json and the Keychain items."
