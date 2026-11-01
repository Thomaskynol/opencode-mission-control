#!/bin/bash
# Manifest of the committed snapshot (no /tmp logs moved into the repo).
# Usage: bash scripts/manifest.sh [--write <arquivo>]
#
# POST-COMMIT RULE (R3 §9): generate AFTER the commit it identifies, from a
# clean tree, and keep the output OUTSIDE the commit it identifies. The
# manifest is evidence about a snapshot, never part of it.
# ANTI-AUTO-REFERENCE: the manifest excludes itself (its own bytes) from the
# listing — a manifest that hashes itself can never be stable. With --write,
# the target file is excluded by its repo-relative path; without --write the
# well-known manifest paths are excluded (see SELF_EXCLUSIONS).
# With .git: branch/HEAD/status + EVERY tracked path mapped to its git blob
# hash (complete output, no truncation).
# Without .git (extracted package): falls back to working-tree sha256 per path
# and states that commit identity is unavailable. Not equivalent to the git
# manifest — limit documented here instead of failing silently.
set -euo pipefail
cd "$(dirname "$0")/.."

# Repo-relative paths that are manifest outputs, never manifest inputs.
SELF_EXCLUSIONS='docs/evidencias-R01-R09/MANIFESTO-R3.txt'

MANIFEST_TARGET_REL=""
if [ "${1:-}" = "--write" ] && [ -n "${2:-}" ]; then
  case "$2" in
    /*) MANIFEST_TARGET_REL="$(realpath --relative-to="$PWD" "$2" 2>/dev/null || basename "$2")" ;;
    *) MANIFEST_TARGET_REL="$2" ;;
  esac
fi

is_self_excluded() {
  local rel="$1"
  if [ -n "$MANIFEST_TARGET_REL" ] && [ "$rel" = "$MANIFEST_TARGET_REL" ]; then
    return 0
  fi
  # shellcheck disable=SC2086
  for excl in $SELF_EXCLUSIONS; do
    if [ "$rel" = "$excl" ]; then
      return 0
    fi
  done
  return 1
}

output_manifest() {
  if git rev-parse --git-dir >/dev/null 2>&1; then
    echo "branch: $(git rev-parse --abbrev-ref HEAD)"
    echo "head: $(git rev-parse HEAD)"
    echo "status:"
    status_out="$(git status --short)"
    printf '%s\n' "$status_out"
    if [ -n "$status_out" ]; then
      echo "clean-tree: false (WARNING: generate the manifest post-commit from a clean tree — see POST-COMMIT RULE above)"
      printf '%s\n' "WARNING: manifest generated with a dirty tree; it does not identify a committed snapshot." >&2
    else
      echo "clean-tree: true"
    fi
    echo "tracked-files (path + git blob hash, complete; manifest excludes itself — ANTI-AUTO-REFERENCE):"
    git ls-files -s | while IFS= read -r line; do
      blob="$(printf '%s' "$line" | awk '{print $2}')"
      path="$(printf '%s' "$line" | cut -f2- -s)"
      if [ "$path" = "$line" ] || [ -z "$path" ]; then
        path="$(printf '%s' "$line" | awk '{$1=$2=$3=""; sub(/^ +/, ""); print}')"
      fi
      if is_self_excluded "$path"; then
        continue
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
      rel="${f#./}"
      if is_self_excluded "$rel" || is_self_excluded "$f"; then
        continue
      fi
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
