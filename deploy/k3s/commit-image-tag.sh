#!/usr/bin/env bash
# Commits "images sha-<7>" for the code commit whose images were just published, on top of the current branch tip —
# unless a newer code commit has landed since (its own run writes its tag: never roll the server back). Tag commits
# themselves carry [skip ci] and are skipped when looking for the newest code commit. Needs full history.
# Used by .github/workflows/images.yml (job deploy-tag), which pushes the result.
# Usage: deploy/k3s/commit-image-tag.sh <full commit sha>
set -euo pipefail
cd "$(dirname "$0")/../.."

sha="${1:-}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: commit-image-tag.sh <40-hex commit sha>" >&2; exit 2; }
tag="sha-${sha:0:7}"

latest=$(git log -1 --format=%H --invert-grep --grep='\[skip ci\]')
if [ "$latest" != "$sha" ]; then
  echo "main has moved on to ${latest:-an unknown commit}; not writing $tag"
  exit 0
fi

deploy/k3s/set-image-tag.sh "$tag"
if git diff --quiet; then
  echo "already at $tag"
  exit 0
fi
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit -q -am "chore(deploy): images $tag [skip ci]"
echo "committed $tag"
