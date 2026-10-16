#!/usr/bin/env bash
# Download the pinned age release into .toolchain/, refusing it unless its
# SHA-256 matches the digest pinned in _age.sh.
#
#   scripts/fetch-age.sh
set -euo pipefail
source "$(dirname "$0")/_age.sh"

if [[ -x "$AGE" ]]; then
  echo "age $AGE_VERSION already at $AGE_DIR"
  exit 0
fi

pinned="$(age_asset)" || exit 1
read -r asset sha <<<"$pinned"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -o "$tmp/$asset" "https://github.com/FiloSottile/age/releases/download/$AGE_VERSION/$asset"
actual="$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1)"
if [[ "$actual" != "$sha" ]]; then
  echo "refusing $asset: sha256 $actual, pinned $sha" >&2
  exit 1
fi

mkdir -p "$AGE_DIR"
tar -xzf "$tmp/$asset" -C "$AGE_DIR"
"$AGE" --version
