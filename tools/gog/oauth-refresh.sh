#!/usr/bin/env bash
set -euo pipefail

# Refresh gog OAuth tokens for headless/cron usage.
#
# Exit codes:
#   0 = auth is healthy (or successfully refreshed)
#   1 = auth check/refresh failed
#   2 = usage/runtime precondition failure

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin"

DB="${CORTANA_DB:-cortana}"
CAL_NAME="${GOG_OAUTH_CHECK_CALENDAR:-Clawdbot-Calendar}"
GOG_ACCOUNT="${GOG_ACCOUNT:-hameldesai3@gmail.com}"
SOURCE="gog-oauth-refresh"

sql_escape() {
  echo "${1:-}" | sed "s/'/''/g"
}

log_event() {
  local sev="$1" msg="$2" meta="${3:-{}}"
  local esc_msg esc_meta
  esc_msg="$(sql_escape "$msg")"
  esc_meta="$(sql_escape "$meta")"
  psql "$DB" -c "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('gog_oauth_refresh', '${SOURCE}', '${sev}', '${esc_msg}', '${esc_meta}'::jsonb);" >/dev/null 2>&1 || true
}

create_alert() {
  local title="$1" desc="$2" meta="${3:-{}}"
  local esc_title esc_desc esc_meta
  esc_title="$(sql_escape "$title")"
  esc_desc="$(sql_escape "$desc")"
  esc_meta="$(sql_escape "$meta")"

  psql "$DB" -c "INSERT INTO cortana_tasks (source, title, description, priority, status, auto_executable, execution_plan, metadata) VALUES ('${SOURCE}', '${esc_title}', '${esc_desc}', 1, 'ready', FALSE, 'Investigate gog OAuth auth failure and re-authorize if needed.', '${esc_meta}'::jsonb);" >/dev/null 2>&1 || true
}

has_auth_refresh_cmd() {
  gog auth --help 2>&1 | grep -qE '^[[:space:]]+refresh([[:space:]]|$)'
}

is_auth_error() {
  local text="${1:-}"
  echo "$text" | grep -Eqi 'auth|oauth|token|invalid_grant|unauthori[sz]ed|credential|login|consent|expired|reauth'
}

run_calendar_probe() {
  gog --account "$GOG_ACCOUNT" cal list "$CAL_NAME" --from today --plain --no-input </dev/null
}

attempt_refresh() {
  gog --account "$GOG_ACCOUNT" auth refresh --no-input </dev/null
}

main() {
  local probe_out probe_rc refresh_out refresh_rc

  set +e
  probe_out="$(run_calendar_probe 2>&1)"
  probe_rc=$?
  set -e

  if [[ $probe_rc -eq 0 ]]; then
    log_event "info" "gog OAuth check passed" "{\"account\":\"${GOG_ACCOUNT}\",\"calendar\":\"${CAL_NAME}\",\"probe_rc\":${probe_rc}}"
    echo "gog oauth ok"
    exit 0
  fi

  if ! is_auth_error "$probe_out"; then
    log_event "error" "gog calendar probe failed (non-auth)" "{\"account\":\"${GOG_ACCOUNT}\",\"calendar\":\"${CAL_NAME}\",\"probe_rc\":${probe_rc},\"error\":\"$(sql_escape "$probe_out")\"}"
    echo "gog oauth probe failed (non-auth): $probe_out" >&2
    exit 1
  fi

  if ! has_auth_refresh_cmd; then
    log_event "error" "gog auth refresh subcommand unavailable" "{\"account\":\"${GOG_ACCOUNT}\",\"calendar\":\"${CAL_NAME}\",\"probe_rc\":${probe_rc},\"error\":\"$(sql_escape "$probe_out")\"}"
    create_alert "gog OAuth refresh unavailable" "gog auth probe failed with auth error, but 'gog auth refresh' is not available in this gog build." "{\"account\":\"${GOG_ACCOUNT}\",\"calendar\":\"${CAL_NAME}\",\"probe_rc\":${probe_rc}}"
    echo "gog oauth auth-error; refresh command unavailable" >&2
    exit 1
  fi

  set +e
  refresh_out="$(attempt_refresh 2>&1)"
  refresh_rc=$?
  set -e

  if [[ $refresh_rc -ne 0 ]]; then
    log_event "error" "gog auth refresh failed" "{\"account\":\"${GOG_ACCOUNT}\",\"calendar\":\"${CAL_NAME}\",\"refresh_rc\":${refresh_rc},\"error\":\"$(sql_escape "$refresh_out")\"}"
    create_alert "gog OAuth refresh failed" "gog auth probe failed and refresh attempt did not recover auth." "{\"account\":\"${GOG_ACCOUNT}\",\"calendar\":\"${CAL_NAME}\",\"refresh_rc\":${refresh_rc}}"
    echo "gog oauth refresh failed: $refresh_out" >&2
    exit 1
  fi

  # Re-check to confirm refresh actually recovered auth.
  set +e
  probe_out="$(run_calendar_probe 2>&1)"
  probe_rc=$?
  set -e

  if [[ $probe_rc -eq 0 ]]; then
    log_event "info" "gog auth refresh succeeded" "{\"account\":\"${GOG_ACCOUNT}\",\"calendar\":\"${CAL_NAME}\"}"
    echo "gog oauth refreshed"
    exit 0
  fi

  log_event "error" "gog auth refresh completed but probe still failing" "{\"account\":\"${GOG_ACCOUNT}\",\"calendar\":\"${CAL_NAME}\",\"probe_rc\":${probe_rc},\"error\":\"$(sql_escape "$probe_out")\"}"
  create_alert "gog OAuth still failing after refresh" "Refresh command returned success but auth probe still fails." "{\"account\":\"${GOG_ACCOUNT}\",\"calendar\":\"${CAL_NAME}\",\"probe_rc\":${probe_rc}}"
  echo "gog oauth still failing after refresh: $probe_out" >&2
  exit 1
}

main "$@"
