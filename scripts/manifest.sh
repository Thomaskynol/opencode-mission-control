#!/bin/bash
# Manifest of the committed snapshot (no /tmp logs moved into the repo).
# Usage: bash scripts/manifest.sh [--write <arquivo>]
# With .git: branch/HEAD/status + EVERY tracked path mapped to its git blob
# hash (complete output, no truncation).
# Without .git (extracted package): falls back to working-tree sha256 per path
# and states that commit identity is unavailable. Not equivalent to the git
# manifest — limit documented here instead of failing silently.
set -euo pipefail
cd "$(dirname "$0")/.."

output_manifest() {
  if git rev-parse --git-dir >/dev/null 2>&1; then
    echo "branch: $(git rev-parse --abbrev-ref HEAD)"
    echo "head: $(git rev-parse HEAD)"
    echo "status:"
    git status --short
    echo "tracked-files (path + git blob hash, complete):"
    git ls-files -s | while IFS= read -r line; do
      blob="$(printf '%s' "$line" | awk '{print $2}')"
      path="$(printf '%s' "$line" | cut -f2- -s)"
      if [ "$path" = "$line" ] || [ -z "$path" ]; then
        path="$(printf '%s' "$line" | awk '{$1=$2=$3=""; sub(/^ +/, ""); print}')"
      fi
      printf '%s  blob:%s\n' "$path" "$blob"
    done | sort
    echo "note: full file list via 'git ls-files'; blob hashes are committed content (see status above for unstaged changes)."
  else
    echo "note: no .git found (extracted package?) — hashes below are working-tree sha256, NOT commit identity."
    echo "branch: (unknown, no .git)"
    echo "head: (unknown, no .git)"
    echo "working-tree-files-sha256:"
    find . -path './.git' -prune -o -type f -print | sort | while IFS= read -r f; do
      h="$(sha256sum "$f" | cut -d' ' -f1)"
      printf '%s  sha256:%s\n' "$f" "$h"
    done
  fi
}

if [ "${1:-}" = "--write" ] && [ -n "${2:-}" ]; then
  output_manifest > "$2"
  echo "wrote $2"
else
  output_manifest
fi
