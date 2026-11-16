#!/bin/bash
# Installs the Local Bridge agent as a per-user LaunchAgent and starts it.
#
#   npm run build && scripts/install.sh
#
# What it does:
#   - copies dist/agent.mjs and dist/cli.mjs to ~/Library/Application Support/local-bridge/
#   - renders ~/Library/LaunchAgents/com.martzmakes.local-bridge.plist with the
#     absolute path of node (override with NODE=/path/to/node)
#   - bootstraps it into the gui/<uid> domain
#
# It does not create the config or the device key; it refuses to run without them.
# Privacy permissions (Automation, Full Disk Access, Reminders) attach to the
# node binary named in the plist: run `doctor` to see which ones are needed.
set -euo pipefail

LABEL="com.martzmakes.local-bridge"
AGENT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUPPORT_DIR="$HOME/Library/Application Support/local-bridge"
LOG_DIR="$HOME/Library/Logs/local-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CONFIG="${LOCAL_BRIDGE_CONFIG:-$HOME/.config/local-bridge/config.json}"
DOMAIN="gui/$(id -u)"

fail() { echo "install: $*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || fail "run as the logged-in user, not root (this is a LaunchAgent)"
[ -f "$AGENT_DIR/dist/agent.mjs" ] && [ -f "$AGENT_DIR/dist/cli.mjs" ] || fail "dist/ is missing; run: npm run build"

NODE_BIN="${NODE:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || fail "node not found; set NODE=/absolute/path/to/node"
case "$NODE_BIN" in /*) ;; *) fail "NODE must be an absolute path" ;; esac
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "node 22 or newer is required (found $("$NODE_BIN" -v) at $NODE_BIN)"

[ -f "$CONFIG" ] || fail "config not found at $CONFIG (start from config.example.json, then chmod 600)"
[ "$(stat -f '%Lp' "$CONFIG")" = "600" ] || fail "config must be mode 600: chmod 600 \"$CONFIG\""
if [ -n "${LOCAL_BRIDGE_CONFIG:-}" ]; then
  fail "LOCAL_BRIDGE_CONFIG is set; the LaunchAgent reads ~/.config/local-bridge/config.json. Unset it and try again."
fi

mkdir -p "$SUPPORT_DIR" "$LOG_DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$SUPPORT_DIR" "$LOG_DIR"
install -m 755 "$AGENT_DIR/dist/agent.mjs" "$SUPPORT_DIR/agent.mjs"
install -m 755 "$AGENT_DIR/dist/cli.mjs" "$SUPPORT_DIR/cli.mjs"

# The key has to exist and be registered before the agent can connect.
"$NODE_BIN" "$SUPPORT_DIR/cli.mjs" pubkey > /dev/null || fail "no device key; run: $NODE_BIN \"$SUPPORT_DIR/cli.mjs\" init"

RENDERED="$(mktemp -t local-bridge-plist)"
trap 'rm -f "$RENDERED"' EXIT
"$AGENT_DIR/scripts/render-plist.sh" "$NODE_BIN" "$SUPPORT_DIR/agent.mjs" "$HOME" "$RENDERED" > /dev/null

if launchctl print "$DOMAIN/$LABEL" > /dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" || true
  # bootout returns before the job is gone
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "$DOMAIN/$LABEL" > /dev/null 2>&1 || break
    sleep 1
  done
fi
install -m 644 "$RENDERED" "$PLIST"
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl enable "$DOMAIN/$LABEL"

echo "Installed $LABEL"
echo "  node:   $NODE_BIN"
echo "  agent:  $SUPPORT_DIR/agent.mjs"
echo "  plist:  $PLIST"
echo "  logs:   $LOG_DIR/agent.log (and agent.err.log)"
echo
echo "Check it:   launchctl print $DOMAIN/$LABEL | head -20"
echo "Diagnose:   $NODE_BIN \"$SUPPORT_DIR/cli.mjs\" doctor"
