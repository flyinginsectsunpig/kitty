#!/usr/bin/env bash
# Points the four Kitty services at one published image build: rewrites image.tag in
# deploy/values/production/kitty-{ledger,web,ai,pulse}.yaml. CI runs it after the images pass their tests and are
# pushed (.github/workflows/images.yml), and commits the result; Argo CD rolls it out. Reverting that commit rolls back.
# Usage: deploy/k3s/set-image-tag.sh sha-<7 hex>
set -euo pipefail
cd "$(dirname "$0")/../.."

tag="${1:-}"
[[ "$tag" =~ ^sha-[0-9a-f]{7}$ ]] || { echo "usage: set-image-tag.sh sha-<7 lowercase hex>, not '$tag'" >&2; exit 2; }

files=(deploy/values/production/kitty-{ledger,web,ai,pulse}.yaml)
for f in "${files[@]}"; do
  [ "$(grep -c '^  tag: ' "$f")" = 1 ] || { echo "$f must have exactly one '  tag:' line" >&2; exit 1; }
done
for f in "${files[@]}"; do
  sed -i -E "s/^  tag: .*/  tag: $tag/" "$f"
done
echo "image tag $tag in ${files[*]}"
