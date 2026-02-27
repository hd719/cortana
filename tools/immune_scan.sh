#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tools/immune_scan.sh [--help] [--dry-run]

Scans for known reliability threats and runs safe auto-heal actions:
- path drift checks + recovery
- service/health checks
- oversized session quarantine (no hard delete)
- tool flap detection from cortana_tool_health
- immune playbook seeding + success-rate tracking

Options:
  --help     Show this help message and exit
  --dry-run  Detect and report only; skip mutations and DB writes
EOF
}

DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

issues=""
PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
PSQL_BIN="/opt/homebrew/opt/postgresql@17/bin/psql"
PG_READY_BIN="/opt/homebrew/opt/postgresql@17/bin/pg_isready"
QUARANTINE_DIR="$HOME/.Trash/cortana-quarantine"

FLAP_FAILS="${IMMUNE_FLAP_FAILS:-4}"
FLAP_MINUTES="${IMMUNE_FLAP_MINUTES:-15}"

mkdir -p "$QUARANTINE_DIR"

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

db_exec() {
  local sql="$1"
  if [ "$DRY_RUN" = "true" ]; then
    return 0
  fi
  if [ -x "$PSQL_BIN" ]; then
    "$PSQL_BIN" cortana -q -X -v ON_ERROR_STOP=1 -t -A -c "$sql" >/dev/null 2>&1 || true
  fi
}

db_scalar() {
  local sql="$1"
  if [ ! -x "$PSQL_BIN" ]; then
    echo ""
    return 0
  fi
  "$PSQL_BIN" cortana -q -X -v ON_ERROR_STOP=1 -t -A -c "$sql" 2>/dev/null | tr -d '[:space:]'
}

log_event() {
  local event_type="$1"
  local severity="$2"
  local message="$3"
  local metadata="${4:-{}}"
  db_exec "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('$(sql_escape "$event_type")','immune_scan','$(sql_escape "$severity")','$(sql_escape "$message")','$(sql_escape "$metadata")'::jsonb);"
}

ensure_playbook_seeded() {
  db_exec "INSERT INTO cortana_immune_playbooks (name, threat_signature, description, actions, tier, enabled, times_used, success_rate)
           VALUES
             ('path_drift_recovery','path_drift','Recover missing expected paths and repair references',
              '[\"verify path exists\",\"attempt mkdir for required directories\",\"log incident\",\"track outcome\"]'::jsonb,
              1, TRUE, 0, 1.0),
             ('tool_flap_recovery','tool_flap','Detect repeated tool failures and escalate/stabilize',
              '[\"count failures in lookback window\",\"flag incident\",\"emit warning event\",\"track success\"]'::jsonb,
              2, TRUE, 0, 1.0)
           ON CONFLICT (name) DO UPDATE
             SET threat_signature = EXCLUDED.threat_signature,
                 description = EXCLUDED.description,
                 actions = EXCLUDED.actions,
                 enabled = TRUE,
                 updated_at = NOW();"
}

track_playbook_result() {
  local name="$1"
  local success="$2"
  local prev_used prev_rate new_used new_rate

  prev_used="$(db_scalar "SELECT COALESCE(times_used,0) FROM cortana_immune_playbooks WHERE name='$(sql_escape "$name")' LIMIT 1;")"
  prev_rate="$(db_scalar "SELECT COALESCE(success_rate,1.0) FROM cortana_immune_playbooks WHERE name='$(sql_escape "$name")' LIMIT 1;")"
  prev_used="${prev_used:-0}"
  prev_rate="${prev_rate:-1.0}"

  new_used=$((prev_used + 1))
  if [ "$success" = "true" ]; then
    new_rate=$(awk -v r="$prev_rate" -v n="$prev_used" 'BEGIN { printf "%.4f", ((r*n)+1)/(n+1) }')
  else
    new_rate=$(awk -v r="$prev_rate" -v n="$prev_used" 'BEGIN { printf "%.4f", ((r*n)+0)/(n+1) }')
  fi

  db_exec "UPDATE cortana_immune_playbooks
           SET times_used=$new_used,
               success_rate=$new_rate,
               last_used=NOW(),
               updated_at=NOW()
           WHERE name='$(sql_escape "$name")';"
}

reconcile_playbook_metrics() {
  db_exec "WITH stats AS (
    SELECT
      p.name,
      COUNT(i.id)::int AS total_used,
      MAX(i.detected_at) AS last_used_at,
      CASE
        WHEN COUNT(i.id) = 0 THEN 1.0
        ELSE ROUND(
          SUM(CASE WHEN i.status='resolved' OR COALESCE(i.auto_resolved,false)=TRUE THEN 1 ELSE 0 END)::numeric / COUNT(i.id)::numeric,
          4
        )
      END AS computed_success
    FROM cortana_immune_playbooks p
    LEFT JOIN cortana_immune_incidents i ON i.playbook_used = p.name
    GROUP BY p.name
  )
  UPDATE cortana_immune_playbooks p
  SET times_used = s.total_used,
      last_used = s.last_used_at,
      success_rate = s.computed_success,
      updated_at = NOW()
  FROM stats s
  WHERE p.name = s.name;"
}

ensure_path_exists() {
  local path="$1"
  local create_if_missing="${2:-false}"
  local playbook="${3:-path_drift_recovery}"

  if [ -e "$path" ]; then
    return 0
  fi

  if [ "$create_if_missing" = "true" ]; then
    if [ "$DRY_RUN" = "true" ] || mkdir -p "$path" 2>/dev/null; then
      issues+="path_drift: RECOVERED $path\n"
      log_event "auto_heal" "info" "Recovered missing path: $path" "{\"path\":\"$(sql_escape "$path")\",\"strategy\":\"mkdir\"}"
      db_exec "INSERT INTO cortana_immune_incidents (detected_at, threat_type, source, severity, description, threat_signature, tier, status, playbook_used, resolution, auto_resolved, metadata)
               VALUES (NOW(),'path_drift','immune_scan','warning','Missing path recovered','path_drift',1,'resolved','$(sql_escape "$playbook")','Path recreated',TRUE,'{\"path\":\"$(sql_escape "$path")\"}'::jsonb);"
      track_playbook_result "$playbook" true
      return 0
    fi
  fi

  issues+="path_drift: MISSING $path\n"
  log_event "immune_alert" "warning" "Missing required path: $path" "{\"path\":\"$(sql_escape "$path")\"}"
  db_exec "INSERT INTO cortana_immune_incidents (detected_at, threat_type, source, severity, description, threat_signature, tier, status, playbook_used, auto_resolved, metadata)
           VALUES (NOW(),'path_drift','immune_scan','warning','Missing required path','path_drift',1,'open','$(sql_escape "$playbook")',FALSE,'{\"path\":\"$(sql_escape "$path")\"}'::jsonb);"
  track_playbook_result "$playbook" false
  return 1
}

quarantine_file() {
  local src="$1"
  if [ ! -e "$src" ]; then
    return 0
  fi
  local base ts dest
  base="$(basename "$src")"
  ts="$(date +%Y%m%d-%H%M%S)"
  dest="$QUARANTINE_DIR/${base}.${ts}.quarantine"

  if [ "$DRY_RUN" = "true" ]; then
    issues+="sessions: WOULD_QUARANTINE $src\n"
    return 0
  fi

  if mv "$src" "$dest"; then
    log_event "auto_heal" "info" "Quarantined file instead of delete" "{\"from\":\"$(sql_escape "$src")\",\"to\":\"$(sql_escape "$dest")\"}"
    return 0
  fi

  issues+="quarantine: FAILED $src\n"
  log_event "immune_alert" "warning" "Failed to quarantine file" "{\"path\":\"$(sql_escape "$src")\"}"
  return 1
}

check_tool_flap() {
  if [ ! -x "$PSQL_BIN" ]; then
    return 0
  fi

  local row tool_name count
  row="$($PSQL_BIN cortana -q -X -t -A -c "
    SELECT tool_name || '|' || COUNT(*)::text
    FROM cortana_tool_health
    WHERE timestamp >= NOW() - INTERVAL '${FLAP_MINUTES} minutes'
      AND LOWER(COALESCE(status,'')) IN ('down','fail','failed','error')
    GROUP BY tool_name
    HAVING COUNT(*) >= ${FLAP_FAILS}
    ORDER BY COUNT(*) DESC
    LIMIT 1;
  " 2>/dev/null || true)"

  if [ -z "$row" ]; then
    return 0
  fi

  tool_name="${row%%|*}"
  count="${row##*|}"
  issues+="tool_flap: ${tool_name} ${count} fails/${FLAP_MINUTES}m\n"

  log_event "immune_alert" "warning" "Tool flap detected: ${tool_name}" "{\"tool\":\"$(sql_escape "$tool_name")\",\"failures\":$count,\"window_minutes\":$FLAP_MINUTES}"
  db_exec "INSERT INTO cortana_immune_incidents (detected_at, threat_type, source, severity, description, threat_signature, tier, status, playbook_used, auto_resolved, metadata)
           VALUES (NOW(),'tool_flap','immune_scan','warning','Repeated tool failures detected','tool_flap',2,'open','tool_flap_recovery',FALSE,
                   '{\"tool\":\"$(sql_escape "$tool_name")\",\"failures\":$count,\"window_minutes\":$FLAP_MINUTES}'::jsonb);"

  track_playbook_result "tool_flap_recovery" true
}

ensure_playbook_seeded

SESSIONS_DIR="$HOME/.openclaw/agents/main/sessions"
ensure_path_exists "$SESSIONS_DIR" true "path_drift_recovery" || true
ensure_path_exists "$HOME/.openclaw/agents/main" true "path_drift_recovery" || true
ensure_path_exists "$QUARANTINE_DIR" true "path_drift_recovery" || true

TOKENS_FILE="$HOME/Developer/cortana-external/tonal_tokens.json"
if [ -f "$TOKENS_FILE" ]; then
  if ! grep -q '"access_token"' "$TOKENS_FILE"; then
    issues+="tonal: NO TOKEN\n"
  fi
else
  issues+="tonal: NO TOKEN\n"
fi

if [ -x "$PG_READY_BIN" ]; then
  if ! "$PG_READY_BIN" -q; then
    issues+="postgres: DOWN\n"
  fi
else
  issues+="postgres: DOWN\n"
fi

if ! curl -sf http://localhost:18800/json > /dev/null; then
  issues+="gateway: DOWN\n"
fi

usage_pct="$(df -h / | tail -1 | awk '{print $5}')"
percent="${usage_pct%%%}"
if [ -n "$percent" ] && [ "$percent" -ge 90 ] 2>/dev/null; then
  issues+="disk: ${usage_pct}\n"
fi

sessions="$(find "$SESSIONS_DIR" -name "*.jsonl" -size +400k 2>/dev/null || true)"
if [ -n "$sessions" ]; then
  while IFS= read -r f; do
    [ -n "$f" ] && quarantine_file "$f" || true
  done <<< "$sessions"
  issues+="sessions: QUARANTINED\n"
fi

check_tool_flap || true
reconcile_playbook_metrics || true

if [ -n "$issues" ]; then
  printf "%b" "$issues"
fi
