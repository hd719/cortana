#!/usr/bin/env bash
set -euo pipefail

JOBS_FILE="${HOME}/.openclaw/cron/jobs.json"
PSQL_BIN="/opt/homebrew/opt/postgresql@17/bin/psql"
MAX_AGE_MS=$((60 * 60 * 1000))

failures=()

if [[ -f "$JOBS_FILE" ]]; then
  while IFS=$'\t' read -r name run_time; do
    [[ -z "${name:-}" || -z "${run_time:-}" ]] && continue
    failures+=("${name}"$'\t'"${run_time}")
  done < <(
    python3 - "$JOBS_FILE" "$MAX_AGE_MS" <<'PY'
import json
import sys
import time
from datetime import datetime, timezone

def coerce_bool(val):
    if isinstance(val, bool):
        return val
    if isinstance(val, str):
        v = val.strip().lower()
        if v in {"false", "0", "no", "n"}:
            return False
        if v in {"true", "1", "yes", "y"}:
            return True
    return val

path = sys.argv[1]
max_age_ms = int(sys.argv[2])
try:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
except Exception:
    sys.exit(0)

jobs = data.get("jobs", [])
if not isinstance(jobs, list):
    sys.exit(0)

now_ms = int(time.time() * 1000)
for job in jobs:
    if not isinstance(job, dict):
        continue
    if not job.get("enabled", False):
        continue

    delivery = job.get("delivery") or {}
    mode = delivery.get("mode") if isinstance(delivery, dict) else None
    if mode == "none":
        continue

    state = job.get("state") or {}
    if not isinstance(state, dict):
        state = {}

    if state.get("lastStatus") != "ok":
        continue

    last_delivered = coerce_bool(state.get("lastDelivered"))
    last_delivery_status = state.get("lastDeliveryStatus")
    if not ((last_delivered is False) or (last_delivery_status != "delivered")):
        continue

    last_run_ms = state.get("lastRunAtMs")
    try:
        last_run_ms = int(last_run_ms)
    except Exception:
        continue

    age_ms = now_ms - last_run_ms
    if age_ms < 0 or age_ms > max_age_ms:
        continue

    name = job.get("name") or "unknown"
    ts = datetime.fromtimestamp(last_run_ms / 1000, tz=timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    print(f"{name}\t{ts}")
PY
  )
fi

if [[ ${#failures[@]} -eq 0 ]]; then
  exit 0
fi

sql_escape() {
  local val="${1:-}"
  val="${val//\'/\'\'}"
  printf "%s" "$val"
}

sql=""
for entry in "${failures[@]}"; do
  name="${entry%%$'\t'*}"
  run_time="${entry#*$'\t'}"
  msg="Cron delivery failure: ${name} last run ${run_time}"
  sql+="INSERT INTO cortana_events (event_type, source, severity, message) "
  sql+="VALUES ('cron_delivery_failure', 'delivery_monitor', 'warning', '$(sql_escape "$msg")');"
done

if [[ -x "$PSQL_BIN" && -n "$sql" ]]; then
  PGHOST="${PGHOST:-localhost}" PGUSER="${PGUSER:-${USER:-hd}}" \
    "$PSQL_BIN" cortana -v ON_ERROR_STOP=1 -c "$sql" >/dev/null 2>&1 || true
fi

count=0
for entry in "${failures[@]}"; do
  echo "${entry%%$'\t'*} ${entry#*$'\t'}"
  count=$((count + 1))
  if [[ $count -ge 3 ]]; then
    break
  fi
done

exit 1
