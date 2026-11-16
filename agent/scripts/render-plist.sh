#!/bin/bash
# Renders the LaunchAgent plist template and lints the result. Installs nothing.
#   render-plist.sh <node-path> <agent-mjs-path> <home-dir> <output-plist>
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <node-path> <agent-mjs-path> <home-dir> <output-plist>" >&2
  exit 2
fi
NODE_PATH_ABS="$1"
AGENT_PATH="$2"
HOME_DIR="$3"
OUT="$4"
TEMPLATE="$(cd "$(dirname "$0")/.." && pwd)/launchd/com.martzmakes.local-bridge.plist.template"

for value in "$NODE_PATH_ABS" "$AGENT_PATH" "$HOME_DIR"; do
  case "$value" in
    /*) ;;
    *) echo "not an absolute path: $value" >&2; exit 2 ;;
  esac
  # These would need escaping for sed or XML; no sane install path has them.
  case "$value" in
    *[\&\<\>\|\"\\]*|*$'\n'*) echo "unsupported character in path: $value" >&2; exit 2 ;;
  esac
done

sed -e "s|@NODE@|$NODE_PATH_ABS|g" -e "s|@AGENT@|$AGENT_PATH|g" -e "s|@HOME@|$HOME_DIR|g" "$TEMPLATE" > "$OUT"
if grep -q '@[A-Z]*@' "$OUT"; then
  echo "unrendered placeholder left in $OUT" >&2
  exit 1
fi
/usr/bin/plutil -lint "$OUT"
