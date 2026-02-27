#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin"

DB="${CORTANA_DB:-cortana}"
SOURCE="rotate-cron-artifacts.sh"
RUN_DIR="${OPENCLAW_CRON_RUN_DIR:-$HOME/.openclaw/cron/runs}"
ROTATE_THRESHOLD_BYTES=$((500 * 1024))   # 500KB
WARN_THRESHOLD_BYTES=$((1024 * 1024))    # 1MB
RETENTION_DAYS=7
KEEP_VERSIONS=3

log_event() {
  local sev="$1" msg="$2" meta="${3:-{}}"
  local esc_msg esc_meta
  esc_msg=$(echo "$msg" | sed "s/'/''/g")
  esc_meta=$(echo "$meta" | sed "s/'/''/g")
  psql "$DB" -c "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('cron_artifact_rotation', '$SOURCE', '$sev', '$esc_msg', '$esc_meta'::jsonb);" >/dev/null 2>&1 || true
}

[[ -d "$RUN_DIR" ]] || {
  log_event "info" "cron runs directory missing; skipping artifact rotation" "{\"run_dir\":\"$RUN_DIR\"}"
  exit 0
}

rotated=0
pruned_versions=0
deleted_old=0
warn_large=0

while IFS= read -r -d '' file; do
  size_bytes=$(stat -f%z "$file" 2>/dev/null || echo 0)
  if [[ "$size_bytes" -le "$ROTATE_THRESHOLD_BYTES" ]]; then
    continue
  fi

  ts=$(date +%Y%m%d%H%M%S)
  archive="${file}.${ts}.gz"

  if gzip -c "$file" > "$archive"; then
    : > "$file"
    rotated=$((rotated + 1))
    log_event "info" "Rotated cron artifact" "{\"file\":\"$file\",\"archive\":\"$archive\",\"bytes_before\":$size_bytes}"
  else
    log_event "error" "Failed to rotate cron artifact" "{\"file\":\"$file\"}"
    rm -f "$archive" || true
    continue
  fi

  keep_idx=0
  while IFS= read -r old; do
    [[ -n "$old" ]] || continue
    keep_idx=$((keep_idx + 1))
    if [[ $keep_idx -le $KEEP_VERSIONS ]]; then
      continue
    fi
    rm -f "$old"
    pruned_versions=$((pruned_versions + 1))
    log_event "info" "Pruned extra rotated artifact" "{\"archive\":\"$old\",\"keep_versions\":$KEEP_VERSIONS}"
  done < <(find "$RUN_DIR" -maxdepth 1 -type f -name "$(basename "$file").*.gz" | sort -r)
done < <(find "$RUN_DIR" -maxdepth 1 -type f -name "*.jsonl" -print0)

while IFS= read -r -d '' oldgz; do
  rm -f "$oldgz"
  deleted_old=$((deleted_old + 1))
  log_event "info" "Deleted expired compressed cron artifact" "{\"archive\":\"$oldgz\",\"retention_days\":$RETENTION_DAYS}"
done < <(find "$RUN_DIR" -maxdepth 1 -type f \( -name "*.jsonl.gz" -o -name "*.jsonl.*.gz" \) -mtime +"$RETENTION_DAYS" -print0)

while IFS= read -r -d '' file; do
  size_bytes=$(stat -f%z "$file" 2>/dev/null || echo 0)
  if [[ "$size_bytes" -gt "$WARN_THRESHOLD_BYTES" ]]; then
    warn_large=$((warn_large + 1))
    log_event "warning" "Oversized cron artifact detected" "{\"file\":\"$file\",\"bytes\":$size_bytes,\"warn_threshold\":$WARN_THRESHOLD_BYTES}"
  fi
done < <(find "$RUN_DIR" -maxdepth 1 -type f -name "*.jsonl" -print0)

log_event "info" "Cron artifact rotation run complete" "{\"run_dir\":\"$RUN_DIR\",\"rotated\":$rotated,\"pruned_versions\":$pruned_versions,\"deleted_old\":$deleted_old,\"oversized_active\":$warn_large}"
echo "rotation complete: rotated=$rotated pruned=$pruned_versions deleted_old=$deleted_old oversized_active=$warn_large"
