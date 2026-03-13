#!/usr/bin/env bash
set -euo pipefail

SOURCE_REPO="${CORTANA_SOURCE_REPO:-/Users/hd/Developer/cortana}"
COMPAT_REPO="${CORTANA_COMPAT_REPO:-/Users/hd/openclaw}"
BACKUP_ROOT="${CORTANA_RUNTIME_BACKUP_ROOT:-$HOME/.openclaw/backups}"
CHECK_ONLY=false

usage() {
  cat <<'EOF'
Install or validate the ~/openclaw compatibility shim.

Usage:
  install-compat-shim.sh [--source-repo <path>] [--compat-repo <path>] [--backup-root <path>] [--check]

Behavior:
  - missing compat path -> create symlink to source repo
  - existing symlink -> repoint to source repo if needed
  - existing directory/repo -> move to timestamped backup, then create symlink
EOF
}

log() {
  printf '[openclaw-shim] %s\n' "$*"
}

die() {
  printf '[openclaw-shim] ERROR: %s\n' "$*" >&2
  exit 1
}

realpath_py() {
  python3 - "$1" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-repo)
      SOURCE_REPO="$2"
      shift 2
      ;;
    --compat-repo)
      COMPAT_REPO="$2"
      shift 2
      ;;
    --backup-root)
      BACKUP_ROOT="$2"
      shift 2
      ;;
    --check)
      CHECK_ONLY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -d "$SOURCE_REPO/.git" ]] || die "source repo missing: $SOURCE_REPO"

source_real="$(realpath_py "$SOURCE_REPO")"

if [[ ! -e "$COMPAT_REPO" && ! -L "$COMPAT_REPO" ]]; then
  if [[ "$CHECK_ONLY" == true ]]; then
    die "compat path missing: $COMPAT_REPO"
  fi
  mkdir -p "$(dirname "$COMPAT_REPO")"
  ln -s "$SOURCE_REPO" "$COMPAT_REPO"
  log "created shim: $COMPAT_REPO -> $SOURCE_REPO"
  exit 0
fi

compat_real="$(realpath_py "$COMPAT_REPO")"
if [[ "$compat_real" == "$source_real" ]]; then
  log "shim already points at source repo"
  exit 0
fi

if [[ "$CHECK_ONLY" == true ]]; then
  die "compat path does not resolve to source repo: $COMPAT_REPO -> $compat_real"
fi

if [[ -L "$COMPAT_REPO" ]]; then
  rm -f "$COMPAT_REPO"
  ln -s "$SOURCE_REPO" "$COMPAT_REPO"
  log "repointed shim: $COMPAT_REPO -> $SOURCE_REPO"
  exit 0
fi

if [[ -d "$COMPAT_REPO/.git" ]]; then
  status="$(git -C "$COMPAT_REPO" status --porcelain --untracked-files=all)"
  [[ -z "$status" ]] || die "compat repo has local changes; refusing migration"
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_path="$BACKUP_ROOT/openclaw-${timestamp}"
mkdir -p "$BACKUP_ROOT"
mv "$COMPAT_REPO" "$backup_path"
ln -s "$SOURCE_REPO" "$COMPAT_REPO"
log "moved legacy runtime path to backup: $backup_path"
log "created shim: $COMPAT_REPO -> $SOURCE_REPO"
