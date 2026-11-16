#!/usr/bin/env bash
# Render every screen of the app to PNG, light and dark, without showing a window.
#
#   scripts/snapshots.sh [dir]        default: build/snapshots
#   LOCAL_BRIDGE_SNAPSHOT_LIVE=1 scripts/snapshots.sh [dir]
#       shows each main-window screen and sheet on screen and captures it with screencapture, so
#       sidebar vibrancy and sheets are real. Needs an unlocked screen and Screen Recording
#       permission; a screen that cannot be captured falls back to the offscreen render and says so.
#       The output line says "not key" when macOS did not let the process become the active app
#       (it does not when started from a background shell), in which case controls stay grey.
#
# Uses fixed sample state. Starts no daemon and touches no Keychain, network or real config.
# Existing images with the same names are overwritten.
set -euo pipefail

MACAPP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MACAPP"
OUT="${1:-$MACAPP/build/snapshots}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

swift build
BIN="$(swift build --show-bin-path)/LocalBridge"
# LOCAL_BRIDGE_SNAPSHOT_LIVE, when set, is passed through to the binary.
LOCAL_BRIDGE_SNAPSHOT_ICON="$MACAPP/Resources/AppIcon.icns" LOCAL_BRIDGE_SNAPSHOT_DIR="$OUT" "$BIN"
echo
echo "$(ls "$OUT" | grep -c '\.png$') images in $OUT"
