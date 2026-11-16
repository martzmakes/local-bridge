#!/usr/bin/env bash
# Build, assemble and sign "Local Bridge.app".
#
#   scripts/build-app.sh
#
# Output: build/Local Bridge.app, signed with the Developer ID certificate and the hardened
# runtime. Not notarized; scripts/release.sh does that.
#
# Environment:
#   LOCALBRIDGE_VERSION, LOCALBRIDGE_BUILD   written into Info.plist when set
#   LOCALBRIDGE_OUT                          output directory (default: build)
#   LOCALBRIDGE_RELEASE=1                    require a secure timestamp and the Developer ID
#                                            certificate; fail instead of falling back
set -euo pipefail

MACAPP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MACAPP"

IDENTITY="Developer ID Application: Matt Martz (EXAMPLETEAM)"
APP_NAME="Local Bridge"
EXECUTABLE="LocalBridge"
AGENT_DIST="$MACAPP/../agent/dist"
OUT="${LOCALBRIDGE_OUT:-build}"
APP="$OUT/$APP_NAME.app"
ENTITLEMENTS="Resources/LocalBridge.entitlements"
RELEASE="${LOCALBRIDGE_RELEASE:-0}"

step() { printf '\n==> %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

for file in cli.mjs agent.mjs; do
  [[ -s "$AGENT_DIST/$file" ]] || die "$AGENT_DIST/$file is missing. Build the agent first: (cd ../agent && npm install && npm run build)"
done

step "swift build -c release"
swift build -c release
BIN_DIR="$(swift build -c release --show-bin-path)"
[[ -x "$BIN_DIR/$EXECUTABLE" ]] || die "swift build did not produce $BIN_DIR/$EXECUTABLE"

step "Assemble $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/agent"
cp "$BIN_DIR/$EXECUTABLE" "$APP/Contents/MacOS/$EXECUTABLE"
cp Resources/Info.plist "$APP/Contents/Info.plist"
[[ -f Resources/AppIcon.icns ]] && cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
cp "$AGENT_DIST/cli.mjs" "$AGENT_DIST/agent.mjs" "$APP/Contents/Resources/agent/"
# Resources, not programs: node reads them. No execute bit, so nothing treats them as code to sign.
chmod 644 "$APP/Contents/Resources/agent/"*.mjs
printf 'APPL????' > "$APP/Contents/PkgInfo"
if [[ -n "${LOCALBRIDGE_VERSION:-}" ]]; then
  plutil -replace CFBundleShortVersionString -string "$LOCALBRIDGE_VERSION" "$APP/Contents/Info.plist"
fi
if [[ -n "${LOCALBRIDGE_BUILD:-}" ]]; then
  plutil -replace CFBundleVersion -string "$LOCALBRIDGE_BUILD" "$APP/Contents/Info.plist"
fi
xattr -cr "$APP"

step "Sign"
SIGNED_WITH=""
if security find-identity -v -p codesigning | grep -qF "\"$IDENTITY\""; then
  SIGN=(codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign "$IDENTITY")
  if "${SIGN[@]}" --timestamp "$APP"; then
    SIGNED_WITH="$IDENTITY, secure timestamp"
  elif [[ "$RELEASE" == "1" ]]; then
    die "codesign failed with a secure timestamp (is timestamp.apple.com reachable?). A release needs one."
  else
    echo "warning: signing with a secure timestamp failed; retrying with --timestamp=none (fine for local use, not for notarization)" >&2
    "${SIGN[@]}" --timestamp=none "$APP"
    SIGNED_WITH="$IDENTITY, no timestamp"
  fi
elif [[ "$RELEASE" == "1" ]]; then
  die "\"$IDENTITY\" is not in the keychain (security find-identity -v -p codesigning). A release needs it."
else
  echo "warning: \"$IDENTITY\" not found; signing ad hoc. macOS privacy grants will not stick to an ad hoc build." >&2
  codesign --force --options runtime --entitlements "$ENTITLEMENTS" --sign - "$APP"
  SIGNED_WITH="ad hoc"
fi

step "Verify"
codesign --verify --deep --strict --verbose=2 "$APP"
echo
echo "Built $APP ($SIGNED_WITH)"
echo "Version $(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist") ($(plutil -extract CFBundleVersion raw "$APP/Contents/Info.plist"))"
