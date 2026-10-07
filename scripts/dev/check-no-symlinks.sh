#!/usr/bin/env bash
# Fails when git tracks a symlink (mode 120000), e.g. a nix `result` link.
# Use as a pre-commit hook:  ln -s ../../scripts/dev/check-no-symlinks.sh .git/hooks/pre-commit
# (the hook link lives in .git, not in the tree). `nix flake check` runs the
# same rule on the flake source (checks.no-symlinks).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
# Index (what will be committed) — staged and already tracked.
links="$(git ls-files -s | awk '$1 == "120000" { $1=$2=$3=""; sub(/^ +/, ""); print }')"
if [ -n "$links" ]; then
  echo "error: git tracks symlinks (not allowed in this repo):" >&2
  while IFS= read -r l; do
    t="$(git cat-file -p "$(git ls-files -s -- "$l" | awk '{print $2}')")"
    case "$t" in /nix/store/*) note=" (Nix store link: build output)";; *) note="";; esac
    echo "  $l -> $t$note" >&2
  done <<<"$links"
  echo "remove them with: git rm --cached <path>   (build outputs: /result* is ignored)" >&2
  exit 1
fi
