#!/bin/bash
# Manifest of the committed snapshot (no /tmp logs moved into the repo).
# Usage: bash scripts/manifest.sh [--write docs/evidencias-R01-R09/MANIFESTO.txt]
set -euo pipefail
cd "$(dirname "$0")/.."
echo "branch: $(git rev-parse --abbrev-ref HEAD)"
echo "head: $(git rev-parse HEAD)"
echo "status:"
git status --short
echo "tracked-files-sha256:"
git ls-files -s | awk '{print $2}' | sort -u | while read -r blob; do
  printf "%s  blob:%s\n" "$(git cat-file -p "$blob" | sha256sum | cut -d" " -f1)" "$blob"
done | head -n 200
echo "note: full file list via 'git ls-files'; hashes above are git blob hashes (committed content)."
if [ "${1:-}" = "--write" ] && [ -n "${2:-}" ]; then
  bash "$0" > "$2"
  echo "wrote $2"
fi
