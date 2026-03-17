#!/usr/bin/env bash
# sync-openclaw-config.sh — Sync live OpenClaw runtime config to repo backup
#
# Copies the authoritative runtime files from ~/.openclaw/ into the repo
# at ~/Developer/cortana/config/ so the repo stays current as a backup.
# Automatically redacts API keys from openclaw.json before writing.
#
# Usage:
#   bash tools/config-sync/sync-openclaw-config.sh          # dry-run (show diff)
#   bash tools/config-sync/sync-openclaw-config.sh --apply  # copy + report
#
# Designed to be run manually, via post-cron-update hook, or as a cron job.

set -eo pipefail

REPO_DIR="${REPO_DIR:-$HOME/Developer/cortana}"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"

# Files to sync: source (relative to ~/.openclaw) → dest (relative to repo)
SYNC_SRC=("cron/jobs.json" "openclaw.json" "agent-profiles.json")
SYNC_DST=("config/cron/jobs.json" "config/openclaw.json" "config/agent-profiles.json")

DRY_RUN=true
if [[ "${1:-}" == "--apply" ]]; then
  DRY_RUN=false
fi

changed=0
unchanged=0
missing=0

for i in "${!SYNC_SRC[@]}"; do
  src_rel="${SYNC_SRC[$i]}"
  dst_rel="${SYNC_DST[$i]}"
  src="$OPENCLAW_DIR/$src_rel"
  dst="$REPO_DIR/$dst_rel"

  if [[ ! -f "$src" ]]; then
    echo "SKIP  $src_rel (source not found)"
    ((missing++)) || true
    continue
  fi

  if [[ ! -f "$dst" ]]; then
    echo "NEW   $src_rel → $dst_rel"
    ((changed++)) || true
    if [[ "$DRY_RUN" == false ]]; then
      mkdir -p "$(dirname "$dst")"
      cp "$src" "$dst"
      # Auto-redact secrets from openclaw.json
      if [[ "$dst_rel" == "config/openclaw.json" ]]; then
        sed -i '' -E 's/"apiKey": "[^"]+"/"apiKey": "REDACTED_USE_LIVE_CONFIG"/g' "$dst"
        sed -i '' -E 's/"credentials": "[^"]+"/"credentials": "REDACTED_USE_LIVE_CONFIG"/g' "$dst"
        sed -i '' -E 's/"botToken": "[^"]+"/"botToken": "REDACTED_USE_LIVE_CONFIG"/g' "$dst"
        sed -i '' -E 's/"token": "[^"]+"/"token": "REDACTED_USE_LIVE_CONFIG"/g' "$dst"
        echo "       copied (secrets redacted)"
      else
        echo "       copied"
      fi
    fi
    continue
  fi

  # For openclaw.json, compare against a redacted version of source
  if [[ "$dst_rel" == "config/openclaw.json" ]]; then
    tmpfile=$(mktemp)
    cp "$src" "$tmpfile"
    sed -i '' -E 's/"apiKey": "[^"]+"/"apiKey": "REDACTED_USE_LIVE_CONFIG"/g' "$tmpfile"
    sed -i '' -E 's/"credentials": "[^"]+"/"credentials": "REDACTED_USE_LIVE_CONFIG"/g' "$tmpfile"
    sed -i '' -E 's/"botToken": "[^"]+"/"botToken": "REDACTED_USE_LIVE_CONFIG"/g' "$tmpfile"
    sed -i '' -E 's/"token": "[^"]+"/"token": "REDACTED_USE_LIVE_CONFIG"/g' "$tmpfile"
    if diff -q "$tmpfile" "$dst" >/dev/null 2>&1; then
      echo "OK    $src_rel (in sync)"
      ((unchanged++)) || true
    else
      echo "DRIFT $src_rel → $dst_rel"
      ((changed++)) || true
      if [[ "$DRY_RUN" == false ]]; then
        cp "$tmpfile" "$dst"
        echo "       synced (secrets redacted)"
      fi
    fi
    rm -f "$tmpfile"
  else
    if diff -q "$src" "$dst" >/dev/null 2>&1; then
      echo "OK    $src_rel (in sync)"
      ((unchanged++)) || true
    else
      echo "DRIFT $src_rel → $dst_rel"
      ((changed++)) || true
      if [[ "$DRY_RUN" == false ]]; then
        cp "$src" "$dst"
        echo "       synced"
      else
        diff --brief "$src" "$dst" 2>/dev/null || true
      fi
    fi
  fi
done

echo ""
echo "Summary: $changed drifted, $unchanged in sync, $missing missing"
if [[ "$DRY_RUN" == true && $changed -gt 0 ]]; then
  echo "Run with --apply to sync."
fi
