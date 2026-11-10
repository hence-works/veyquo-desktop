#!/usr/bin/env bash
# Fills packages/ with the five workspaces the desktop app builds against. They live in the
# private hence-works/veyquo repository and are never committed here.
#
#   scripts/fetch-private-packages.sh                 the commit in private-packages.ref
#   scripts/fetch-private-packages.sh --from ../veyquo  a local checkout, uncommitted work included
#
# CI checks the private repository out itself, in one step that holds the deploy key, and then
# uses --from, so this script never sees a credential there.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
names=(device-protocol eslint-config local-executor typescript-config ui)
repository="${VEYQUO_PRIVATE_REPOSITORY:-https://github.com/hence-works/veyquo.git}"

from=""
if [ "${1:-}" = "--from" ]; then
  from="${2:?--from needs a path to a veyquo checkout}"
elif [ "$#" -gt 0 ]; then
  echo "usage: $0 [--from <veyquo checkout>]" >&2
  exit 2
fi

temporary=""
cleanup() { if [ -n "$temporary" ]; then rm -rf "$temporary"; fi; }
trap cleanup EXIT

if [ -z "$from" ]; then
  ref="$(tr -d '[:space:]' <"$root/private-packages.ref")"
  if ! [[ "$ref" =~ ^[0-9a-f]{40}$ ]]; then
    echo "private-packages.ref must hold a full commit SHA" >&2
    exit 2
  fi
  temporary="$(mktemp -d)"
  from="$temporary"
  git -C "$from" init -q
  git -C "$from" remote add origin "$repository"
  git -C "$from" sparse-checkout set "${names[@]/#/packages/}"
  git -C "$from" fetch -q --depth 1 origin "$ref"
  git -C "$from" -c advice.detachedHead=false checkout -q FETCH_HEAD
fi

for name in "${names[@]}"; do
  if [ ! -f "$from/packages/$name/package.json" ]; then
    echo "packages/$name is missing from the source checkout" >&2
    exit 1
  fi
done

rm -rf "$root/packages"
mkdir -p "$root/packages"
tar -C "$from/packages" --exclude=node_modules --exclude=dist --exclude=coverage -cf - "${names[@]}" |
  tar -C "$root/packages" -xf -

echo "packages/: ${names[*]}"
