#!/usr/bin/env bash
# Publish a prepared Local Bridge update to the live CloudFront channel.
set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
[[ $# == 1 && "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: $0 <version>"
VERSION="$1"
MACAPP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${LOCALBRIDGE_RELEASE_ROOT:-$MACAPP/build/release}/$VERSION"
ARCHIVE="LocalBridge-Mac-$VERSION.zip"
ZIP="$OUT/$ARCHIVE"
FEED="$OUT/appcast.xml"
SIGN_UPDATE="$MACAPP/.build/artifacts/sparkle/Sparkle/bin/sign_update"
KEY_ACCOUNT="${LOCALBRIDGE_SPARKLE_KEY_ACCOUNT:-local-bridge}"
export AWS_REGION="${AWS_REGION:-us-east-1}"

[[ -s "$ZIP" && -s "$FEED" && -x "$SIGN_UPDATE" ]] || die "prepare the release with release.sh first"
"$SIGN_UPDATE" --account "$KEY_ACCOUNT" --verify "$FEED"
SIGNATURE="$(xmllint --xpath 'string(/rss/channel/item/enclosure/@*[local-name()="edSignature"])' "$FEED")"
"$SIGN_UPDATE" --account "$KEY_ACCOUNT" --verify "$ZIP" "$SIGNATURE"
BUILD="$(xmllint --xpath 'string(/rss/channel/item/*[local-name()="version"])' "$FEED")"
[[ "$BUILD" =~ ^[0-9]+$ ]] || die "appcast is missing the numeric build number"

read_stack_output() {
  aws cloudformation describe-stacks --no-cli-pager --stack-name "${LOCAL_BRIDGE_STACK_NAME:-LocalBridgeStack}" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}
BUCKET="$(read_stack_output SiteBucketName)"
FEED_URL="$(read_stack_output UpdateFeedUrl)"
[[ -n "$BUCKET" && "$BUCKET" != None && "$FEED_URL" == https://*/updates/appcast.xml ]] || die "deploy the update channel first"
DOWNLOAD_URL="$(xmllint --xpath 'string(/rss/channel/item/enclosure/@url)' "$FEED")"
[[ "$DOWNLOAD_URL" == "${FEED_URL%/appcast.xml}/$ARCHIVE" ]] || die "appcast archive URL does not match the stack"

etag() {
  aws s3api list-objects-v2 --no-cli-pager --bucket "$BUCKET" --prefix "$1" \
    --query "Contents[?Key=='$1'].ETag | [0]" --output text
}
DIST_FEED="updates/appcast.xml"
FEED_ETAG="$(etag "$DIST_FEED")"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
if [[ "$FEED_ETAG" != None ]]; then
  aws s3api get-object --no-cli-pager --bucket "$BUCKET" --key "$DIST_FEED" \
    --if-match "$FEED_ETAG" "$TEMP/appcast.xml" >/dev/null
  "$SIGN_UPDATE" --account "$KEY_ACCOUNT" --verify "$TEMP/appcast.xml"
  if cmp -s "$TEMP/appcast.xml" "$FEED"; then
    printf 'Build %s is already live at %s\n' "$BUILD" "$FEED_URL"
    exit 0
  fi
  CURRENT_BUILD="$(xmllint --xpath 'string(/rss/channel/item/*[local-name()="version"])' "$TEMP/appcast.xml")"
  [[ "$CURRENT_BUILD" =~ ^[0-9]+$ ]] && (( 10#$BUILD > 10#$CURRENT_BUILD )) \
    || die "build $BUILD must be newer than the live feed"
  FEED_CONDITION=(--if-match "$FEED_ETAG")
else
  FEED_CONDITION=(--if-none-match '*')
fi

DIST_ZIP="updates/$ARCHIVE"
ZIP_SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"
ARCHIVE_ETAG="$(etag "$DIST_ZIP")"
if [[ "$ARCHIVE_ETAG" == None ]]; then
  aws s3api put-object --no-cli-pager --bucket "$BUCKET" --key "$DIST_ZIP" --body "$ZIP" \
    --if-none-match '*' --metadata "sha256=$ZIP_SHA" \
    --content-type application/zip --cache-control 'public, max-age=31536000, immutable' >/dev/null
else
  STORED_SHA="$(aws s3api head-object --no-cli-pager --bucket "$BUCKET" --key "$DIST_ZIP" \
    --query Metadata.sha256 --output text)"
  [[ "$STORED_SHA" == "$ZIP_SHA" ]] || die "the archive already exists with different bytes"
fi

# Publish the signed feed last so it can only point at a completed upload.
aws s3api put-object --no-cli-pager --bucket "$BUCKET" --key "$DIST_FEED" --body "$FEED" \
  "${FEED_CONDITION[@]}" --content-type application/xml --cache-control 'no-cache' >/dev/null
printf 'Published build %s at %s\n' "$BUILD" "$FEED_URL"
