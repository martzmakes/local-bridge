#!/usr/bin/env bash
# Cut a signed, notarized Local Bridge for Mac.
#
#   scripts/release.sh <version> [--build <n>]
#
# Steps: build and sign with scripts/build-app.sh in release mode (Developer ID, hardened runtime,
# secure timestamp; no fallback), notarize, staple, check with Gatekeeper, zip.
#
# Leaves the app, ZIP, and signed appcast in build/release/<version> (or LOCALBRIDGE_RELEASE_ROOT).
# Apple notarization is the only upload. Run publish-update.sh separately.
#
# Needs: a Developer ID Application certificate selected by LOCALBRIDGE_SIGNING_IDENTITY in the login keychain, and
# notary credentials: the App Store Connect API key in ~/.appstoreconnect/private_keys, or the
# notarytool keychain profile "local-bridge-notary". LOCALBRIDGE_ASC_KEY_ID, LOCALBRIDGE_ASC_KEY_FILE,
# LOCALBRIDGE_ASC_ISSUER and LOCALBRIDGE_NOTARY_PROFILE override.
set -euo pipefail

usage() { echo "usage: $0 <version> [--build <n>]" >&2; exit 2; }

VERSION=""
BUILD=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build) shift; [[ $# -gt 0 ]] || usage; BUILD="$1" ;;
    -h|--help) usage ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) [[ -z "$VERSION" ]] || usage; VERSION="$1" ;;
  esac
  shift
done
[[ -n "$VERSION" ]] || usage
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must look like 1.2.3, got '$VERSION'" >&2; exit 2; }
# The build number defaults to a timestamp, so it always increases.
[[ -n "$BUILD" ]] || BUILD="$(date -u +%Y%m%d%H%M)"
[[ "$BUILD" =~ ^[0-9]+$ ]] || { echo "build number must be an integer, got '$BUILD'" >&2; exit 2; }

MACAPP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$MACAPP"

PRODUCT="Local Bridge"
# Notary credentials: an App Store Connect API key when its .p8 is present (the same key the other
# release scripts on this Mac use; it needs no keychain), else the notarytool keychain profile.
NOTARY_PROFILE="${LOCALBRIDGE_NOTARY_PROFILE:-local-bridge-notary}"
ASC_KEY_ID="${LOCALBRIDGE_ASC_KEY_ID:-}"
ASC_KEY_FILE="${LOCALBRIDGE_ASC_KEY_FILE:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
ASC_ISSUER="${LOCALBRIDGE_ASC_ISSUER:-}"
if [[ -n "$ASC_KEY_ID" && -n "$ASC_ISSUER" && -f "$ASC_KEY_FILE" ]]; then
  NOTARY_AUTH=(--key "$ASC_KEY_FILE" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER")
  NOTARY_LABEL="API key $ASC_KEY_ID"
else
  NOTARY_AUTH=(--keychain-profile "$NOTARY_PROFILE")
  NOTARY_LABEL="keychain profile $NOTARY_PROFILE"
fi

OUT="${LOCALBRIDGE_RELEASE_ROOT:-$MACAPP/build/release}/$VERSION"
SPARKLE_ACCOUNT="${LOCALBRIDGE_SPARKLE_KEY_ACCOUNT:-local-bridge}"
SPARKLE_BIN="$MACAPP/.build/artifacts/sparkle/Sparkle/bin"
APP="$OUT/$PRODUCT.app"
ZIP_NAME="LocalBridge-Mac-$VERSION.zip"
ZIP="$OUT/$ZIP_NAME"

step() { printf '\n==> %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# Check the notary credentials before spending time on a build that could not be notarized.
xcrun notarytool history "${NOTARY_AUTH[@]}" >/dev/null 2>&1 \
  || die "notary credentials rejected ($NOTARY_LABEL). Add the API key at $ASC_KEY_FILE or run: xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id <id> --team-id <team-id>"

# --- 1. build and sign --------------------------------------------------------------------------
step "Build $PRODUCT $VERSION ($BUILD)"
[[ ! -e "$OUT" ]] || die "release directory already exists at $OUT"
mkdir -p "$OUT"
LOCALBRIDGE_RELEASE=1 LOCALBRIDGE_OUT="$OUT" LOCALBRIDGE_VERSION="$VERSION" LOCALBRIDGE_BUILD="$BUILD" \
  scripts/build-app.sh
[[ -d "$APP" ]] || die "build-app.sh did not produce $APP"

SIGNING_INFO="$(codesign -dvv "$APP" 2>&1)"
[[ "$SIGNING_INFO" == *'Authority=Developer ID Application'* ]] || die "$APP is not signed with a Developer ID certificate: $SIGNING_INFO"
[[ "$SIGNING_INFO" == *'Timestamp='* ]] || die "$APP has no secure timestamp; notarization would refuse it"
[[ "$SIGNING_INFO" == *'flags=0x10000(runtime)'* ]] || die "$APP is not signed with the hardened runtime"
SHORT="$(plutil -extract CFBundleShortVersionString raw "$APP/Contents/Info.plist")"
BUNDLE_BUILD="$(plutil -extract CFBundleVersion raw "$APP/Contents/Info.plist")"
[[ "$SHORT" == "$VERSION" && "$BUNDLE_BUILD" == "$BUILD" ]] || die "the app reports $SHORT ($BUNDLE_BUILD), expected $VERSION ($BUILD)"
FEED_URL="$(plutil -extract SUFeedURL raw "$APP/Contents/Info.plist")"
[[ "$FEED_URL" == https://*/appcast.xml ]] || die "SUFeedURL must be an HTTPS appcast.xml URL"
PUBLIC_KEY="$(plutil -extract SUPublicEDKey raw "$APP/Contents/Info.plist")"
SIGNING_KEY="$("$SPARKLE_BIN/generate_keys" --account "$SPARKLE_ACCOUNT" -p)"
[[ -n "$PUBLIC_KEY" && "$PUBLIC_KEY" == "$SIGNING_KEY" ]] || die "the app's Sparkle public key does not match Keychain account $SPARKLE_ACCOUNT"

# --- 2. notarize and staple ---------------------------------------------------------------------
step "Notarize with $NOTARY_LABEL"
NOTARIZE_ZIP="$OUT/LocalBridge-notarize.zip"
ditto -c -k --keepParent "$APP" "$NOTARIZE_ZIP"
NOTARY_LOG="$OUT/notarytool.log"
xcrun notarytool submit "$NOTARIZE_ZIP" "${NOTARY_AUTH[@]}" --wait 2>&1 | tee "$NOTARY_LOG"
grep -q '^ *status: Accepted' "$NOTARY_LOG" || die "notarization was not accepted (see $NOTARY_LOG)"
rm -f "$NOTARIZE_ZIP"

step "Staple"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=2 "$APP" 2>&1 | tail -n 2

# --- 3. zip -------------------------------------------------------------------------------------
step "Zip $ZIP_NAME"
ditto -c -k --keepParent "$APP" "$ZIP"
[[ -s "$ZIP" ]] || die "zip is empty"
ls -la "$ZIP"

# Generate a signed feed locally. Publication is a separate, explicit action.
step "Sign update feed"
APPCAST="$OUT/appcast.xml"
"$SPARKLE_BIN/generate_appcast" --account "$SPARKLE_ACCOUNT" --maximum-deltas 0 \
  --download-url-prefix "${FEED_URL%/appcast.xml}/" -o "$APPCAST" "$OUT"
"$SPARKLE_BIN/sign_update" --account "$SPARKLE_ACCOUNT" --verify "$APPCAST"
SIGNATURE="$(xmllint --xpath 'string(//enclosure/@*[local-name()="edSignature"])' "$APPCAST")"
"$SPARKLE_BIN/sign_update" --account "$SPARKLE_ACCOUNT" --verify "$ZIP" "$SIGNATURE"

step "Prepared $PRODUCT $VERSION ($BUILD)"
echo "app: $APP"
echo "zip: $ZIP"
echo "feed: $APPCAST"
