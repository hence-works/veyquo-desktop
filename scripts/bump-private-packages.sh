#!/usr/bin/env bash
# Moves private-packages.ref to a commit on the private repository's main branch (its tip when
# no commit is given), refetches the packages and refreshes yarn.lock. Review and commit both
# files through a pull request.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repository="${VEYQUO_PRIVATE_REPOSITORY:-https://github.com/hence-works/veyquo.git}"

sha="${1:-$(git ls-remote "$repository" refs/heads/main | cut -f1)}"
if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "expected a full commit SHA, got: $sha" >&2
  exit 2
fi

echo "$sha" >"$root/private-packages.ref"
"$root/scripts/fetch-private-packages.sh"
cd "$root"
yarn install
