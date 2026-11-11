#!/usr/bin/env bash
# Uploads a store zip to the Chrome Web Store (API v2) and submits it for review.
#
#   scripts/chrome-web-store-publish.sh apps/chrome-extension/release/veyquo-chrome-extension-<v>-store.zip
#
# Environment:
#   CWS_ACCESS_TOKEN  OAuth access token with the https://www.googleapis.com/auth/chromewebstore
#                     scope, for an account or service account the Developer Dashboard admits
#   CWS_PUBLISHER_ID  the publisher id from the Developer Dashboard
#   CWS_EXTENSION_ID  the store item id (not the development id)
#   CWS_PUBLISH_TYPE  DEFAULT_PUBLISH (live once approved) or STAGED_PUBLISH (wait for a person
#                     to publish it in the dashboard); default STAGED_PUBLISH
#
# Prints the API's responses, which carry ids and states only.
set -euo pipefail

zip="${1:?usage: $0 <store zip>}"
: "${CWS_ACCESS_TOKEN:?}" "${CWS_PUBLISHER_ID:?}" "${CWS_EXTENSION_ID:?}"
publish_type="${CWS_PUBLISH_TYPE:-STAGED_PUBLISH}"
case "$publish_type" in DEFAULT_PUBLISH | STAGED_PUBLISH) ;; *)
  echo "CWS_PUBLISH_TYPE must be DEFAULT_PUBLISH or STAGED_PUBLISH" >&2
  exit 2
  ;;
esac

if unzip -p "$zip" manifest.json | jq -e 'has("key")' >/dev/null; then
  echo "$zip still has the development key; use the -store.zip" >&2
  exit 1
fi

base="${CWS_API_BASE:-https://chromewebstore.googleapis.com}" # overridable for a local stub
item="publishers/$CWS_PUBLISHER_ID/items/$CWS_EXTENSION_ID"
auth=(-H "Authorization: Bearer $CWS_ACCESS_TOKEN")

upload="$(curl -sS --fail-with-body "${auth[@]}" -X POST -T "$zip" \
  -H 'Content-Type: application/zip' "$base/upload/v2/$item:upload")"
echo "upload: $upload"
state="$(jq -r .uploadState <<<"$upload")"

for _ in $(seq 1 30); do
  [ "$state" = IN_PROGRESS ] || break
  sleep 10
  status="$(curl -sS --fail-with-body "${auth[@]}" "$base/v2/$item:fetchStatus")"
  state="$(jq -r '.lastAsyncUploadState // "IN_PROGRESS"' <<<"$status")"
done
if [ "$state" != SUCCEEDED ]; then
  echo "upload did not succeed: $state" >&2
  exit 1
fi

publish="$(curl -sS --fail-with-body "${auth[@]}" -X POST -H 'Content-Type: application/json' \
  -d "$(jq -n --arg t "$publish_type" '{publishType: $t}')" "$base/v2/$item:publish")"
echo "publish: $publish"
