#!/usr/bin/env bash
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
PSQL_BIN="/opt/homebrew/opt/postgresql@17/bin/psql"
DB_NAME="${CORTANA_DB:-cortana}"
SOURCE="${ALERT_INTENT_SOURCE:-alert-intent-emitter}"

ALERT_TYPE="${1:-${ALERT_TYPE:-generic}}"
TARGET_CHANNEL="${2:-${TARGET_CHANNEL:-telegram}}"
EXPECTED_DELIVERY_TIME="${3:-${EXPECTED_DELIVERY_TIME:-}}"
INTENT_ID="${4:-${ALERT_INTENT_ID:-}}"

if [[ -z "$ALERT_TYPE" ]]; then
  echo "Usage: $(basename "$0") <alert_type> [target_channel] [expected_delivery_time_iso8601] [intent_id]" >&2
  exit 1
fi

if [[ ! -x "$PSQL_BIN" ]]; then
  echo "psql not found at $PSQL_BIN" >&2
  exit 1
fi

sql_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

if [[ -z "$INTENT_ID" ]]; then
  if command -v uuidgen >/dev/null 2>&1; then
    INTENT_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  else
    INTENT_ID="$(/usr/bin/python3 -c 'import uuid; print(uuid.uuid4())')"
  fi
fi

if [[ -z "$EXPECTED_DELIVERY_TIME" ]]; then
  EXPECTED_SECONDS="${ALERT_EXPECTED_DELIVERY_SECONDS:-120}"
  EXPECTED_DELIVERY_TIME="$(/bin/date -u -v+"${EXPECTED_SECONDS}"S +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || /usr/bin/python3 - <<'PY'
from datetime import datetime, timedelta, timezone
import os
sec=int(os.environ.get('ALERT_EXPECTED_DELIVERY_SECONDS','120'))
print((datetime.now(timezone.utc)+timedelta(seconds=sec)).strftime('%Y-%m-%dT%H:%M:%SZ'))
PY
)"
fi

ESC_MSG="$(sql_escape "Alert intent registered: type=${ALERT_TYPE}, intent_id=${INTENT_ID}, target=${TARGET_CHANNEL}")"
ESC_META="$(sql_escape "{\"intent_id\":\"${INTENT_ID}\",\"alert_type\":\"${ALERT_TYPE}\",\"target_channel\":\"${TARGET_CHANNEL}\",\"expected_delivery_time\":\"${EXPECTED_DELIVERY_TIME}\"}")"

"$PSQL_BIN" "$DB_NAME" -q -X -v ON_ERROR_STOP=1 -c "
  INSERT INTO cortana_events (event_type, source, severity, message, metadata)
  VALUES (
    'alert_intent',
    '$(sql_escape "$SOURCE")',
    'info',
    '${ESC_MSG}',
    '${ESC_META}'::jsonb
  );
" >/dev/null

printf '{"ok":true,"intent_id":"%s","alert_type":"%s","target_channel":"%s","expected_delivery_time":"%s"}\n' \
  "$INTENT_ID" "$ALERT_TYPE" "$TARGET_CHANNEL" "$EXPECTED_DELIVERY_TIME"
