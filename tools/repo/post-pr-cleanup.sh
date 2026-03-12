#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

repo_args=()
if [[ $# -eq 0 ]]; then
  if repo="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null)"; then
    repo_args=(--repo "$repo")
  fi
fi

cmd=(bash "$ROOT/tools/repo/repo-auto-sync.sh" --post-merge)
if (( ${#repo_args[@]} > 0 )); then
  cmd+=("${repo_args[@]}")
fi
if (( $# > 0 )); then
  cmd+=("$@")
fi

"${cmd[@]}"
