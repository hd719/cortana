#!/usr/bin/env bash
# sync-openclaw-config.sh — Sync live OpenClaw runtime config to repo backup
#
# Copies the authoritative runtime files from ~/.openclaw/ into the repo
# at ~/Developer/cortana/config/ so the repo stays current as a backup.
# Automatically redacts API keys/tokens from openclaw.json before writing.
#
# Usage:
#   bash tools/config-sync/sync-openclaw-config.sh          # dry-run (show diff)
#   bash tools/config-sync/sync-openclaw-config.sh --apply  # copy + report

set -eo pipefail

REPO_DIR="${REPO_DIR:-$HOME/Developer/cortana}"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"

SYNC_SRC=("cron/jobs.json" "openclaw.json" "agent-profiles.json")
SYNC_DST=("config/cron/jobs.json" "config/openclaw.json" "config/agent-profiles.json")

DRY_RUN=true
[[ "${1:-}" == "--apply" ]] && DRY_RUN=false

redact_secrets() {
  local file="$1"
  sed -i '' -E 's/"apiKey": "[^"]+"/"apiKey": "REDACTED_USE_LIVE_CONFIG"/g' "$file"
  sed -i '' -E 's/"botToken": "[^"]+"/"botToken": "REDACTED_USE_LIVE_CONFIG"/g' "$file"
  sed -i '' -E 's/"token": "[^"]+"/"token": "REDACTED_USE_LIVE_CONFIG"/g' "$file"
  sed -i '' -E 's/"credentials": "[^"]+"/"credentials": "REDACTED_USE_LIVE_CONFIG"/g' "$file"
}

changed=0; unchanged=0; missing=0

for i in "${!SYNC_SRC[@]}"; do
  src_rel="${SYNC_SRC[$i]}"
  dst_rel="${SYNC_DST[$i]}"
  src="$OPENCLAW_DIR/$src_rel"
  dst="$REPO_DIR/$dst_rel"

  if [[ ! -f "$src" ]]; then
    echo "SKIP  $src_rel (source not found)"; ((missing++)) || true; continue
  fi

  needs_redact=false
  [[ "$dst_rel" == "config/openclaw.json" ]] && needs_redact=true

  # Build a comparable version of the source
  tmpfile=$(mktemp)
  cp "$src" "$tmpfile"
  $needs_redact && redact_secrets "$tmpfile"

  if [[ ! -f "$dst" ]]; then
    echo "NEW   $src_rel → $dst_rel"; ((changed++)) || true
    if [[ "$DRY_RUN" == false ]]; then
      mkdir -p "$(dirname "$dst")"; cp "$tmpfile" "$dst"
      echo "       copied${needs_redact:+ (secrets redacted)}"
    fi
  elif diff -q "$tmpfile" "$dst" >/dev/null 2>&1; then
    echo "OK    $src_rel (in sync)"; ((unchanged++)) || true
  else
    echo "DRIFT $src_rel → $dst_rel"; ((changed++)) || true
    if [[ "$DRY_RUN" == false ]]; then
      cp "$tmpfile" "$dst"
      echo "       synced${needs_redact:+ (secrets redacted)}"
    fi
  fi
  rm -f "$tmpfile"
done

echo ""
echo "Summary: $changed drifted, $unchanged in sync, $missing missing"
[[ "$DRY_RUN" == true && $changed -gt 0 ]] && echo "Run with --apply to sync."
