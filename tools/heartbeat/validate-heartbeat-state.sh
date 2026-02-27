#!/usr/bin/env bash
set -euo pipefail

STATE_FILE="${HEARTBEAT_STATE_FILE:-$HOME/clawd/memory/heartbeat-state.json}"
PSQL_BIN="${PSQL_BIN:-/opt/homebrew/opt/postgresql@17/bin/psql}"
DB_NAME="${DB_NAME:-cortana}"
SNAPSHOT_INTERVAL_SEC="${SNAPSHOT_INTERVAL_SEC:-21600}" # 6h
MAX_STALE_MS=$((48 * 60 * 60 * 1000))

VALIDATION_OUT="$(python3 - "$STATE_FILE" "$MAX_STALE_MS" <<'PY'
import json
import os
import shutil
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

state_file = Path(sys.argv[1]).expanduser()
max_stale_ms = int(sys.argv[2])
now_ms = int(time.time() * 1000)
version = 2
required_checks = [
    "email", "calendar", "watchlist", "tasks", "portfolio", "marketIntel",
    "techNews", "weather", "fitness", "apiBudget", "mission", "cronDelivery"
]

def parse_ts(value, allow_zero=False):
    if value is None:
        raise ValueError("timestamp missing")
    if isinstance(value, bool):
        raise ValueError("invalid bool timestamp")
    if isinstance(value, (int, float)):
        n = int(value)
        if n == 0 and allow_zero:
            return 0
        if n < 1_000_000_000_000:
            if n < 1_000_000_000:
                raise ValueError("numeric timestamp too small")
            n *= 1000
        return n
    if isinstance(value, str):
        s = value.strip()
        if not s:
            raise ValueError("empty timestamp string")
        if s.isdigit():
            return parse_ts(int(s))
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    raise ValueError(f"unsupported timestamp type: {type(value).__name__}")

def validate_and_normalize(raw):
    if not isinstance(raw, dict):
        raise ValueError("state root must be object")

    last_checks_raw = raw.get("lastChecks")
    if not isinstance(last_checks_raw, dict):
        raise ValueError("lastChecks must be object")

    normalized_checks = {}
    for key in required_checks:
        if key not in last_checks_raw:
            raise ValueError(f"missing required check: {key}")
        val = last_checks_raw[key]
        ts_src = val.get("lastChecked") if isinstance(val, dict) else val
        ts = parse_ts(ts_src)
        age = now_ms - ts
        if ts > now_ms + 5 * 60 * 1000:
            raise ValueError(f"{key} timestamp in future")
        if age > max_stale_ms:
            raise ValueError(f"{key} timestamp stale")
        normalized_checks[key] = {"lastChecked": ts}

    sub = raw.get("subagentWatchdog") or {"lastRun": now_ms, "lastLogged": {}}
    if not isinstance(sub, dict):
        raise ValueError("subagentWatchdog must be object")
    last_logged = sub.get("lastLogged", {})
    if not isinstance(last_logged, dict):
        raise ValueError("subagentWatchdog.lastLogged must be object")

    normalized = {
        "version": version,
        "lastChecks": normalized_checks,
        "lastRemediationAt": parse_ts(raw.get("lastRemediationAt", now_ms), allow_zero=True),
        "subagentWatchdog": {
            "lastRun": parse_ts(sub.get("lastRun", now_ms), allow_zero=True),
            "lastLogged": {str(k): parse_ts(v, allow_zero=True) for k, v in last_logged.items()},
        },
    }
    if "lastSnapshotAt" in raw:
        try:
            normalized["lastSnapshotAt"] = parse_ts(raw.get("lastSnapshotAt"))
        except Exception:
            pass
    return normalized

def default_state():
    return {
        "version": version,
        "lastChecks": {k: {"lastChecked": now_ms} for k in required_checks},
        "lastRemediationAt": now_ms,
        "subagentWatchdog": {"lastRun": now_ms, "lastLogged": {}},
    }

def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=2) + "\n"
    with tempfile.NamedTemporaryFile("w", dir=str(path.parent), delete=False) as tmp:
        tmp.write(payload)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_name = tmp.name
    os.replace(tmp_name, path)

result = {"ok": True, "action": "validated", "restoredFrom": None, "usedDefault": False}
normalized = None
invalid_reason = None

if state_file.exists():
    try:
        normalized = validate_and_normalize(json.loads(state_file.read_text()))
    except Exception as e:
        invalid_reason = str(e)

if normalized is None:
    for i in (1, 2, 3):
        candidate = Path(str(state_file) + f".bak.{i}")
        if not candidate.exists():
            continue
        try:
            normalized = validate_and_normalize(json.loads(candidate.read_text()))
            result["action"] = "restored_from_backup"
            result["restoredFrom"] = str(candidate)
            break
        except Exception:
            continue

if normalized is None:
    normalized = default_state()
    result["action"] = "reinitialized_default"
    result["usedDefault"] = True

if invalid_reason:
    result["invalidReason"] = invalid_reason

atomic_write(state_file, normalized)

# rotate rolling backups on successful validation write
b1 = Path(str(state_file) + ".bak.1")
b2 = Path(str(state_file) + ".bak.2")
b3 = Path(str(state_file) + ".bak.3")
if b2.exists():
    shutil.copy2(b2, b3)
if b1.exists():
    shutil.copy2(b1, b2)
shutil.copy2(state_file, b1)

ages = [now_ms - v["lastChecked"] for v in normalized["lastChecks"].values() if isinstance(v, dict)]
result["summary"] = {
    "version": normalized.get("version"),
    "checkCount": len(normalized.get("lastChecks", {})),
    "oldestAgeMs": max(ages) if ages else 0,
    "newestAgeMs": min(ages) if ages else 0,
}
result["statePath"] = str(state_file)
print(json.dumps(result))
PY
)"

if [ -x "$PSQL_BIN" ]; then
  export PGHOST="${PGHOST:-localhost}"
  export PGUSER="${PGUSER:-$USER}"

  LAST_AGE_SEC="$($PSQL_BIN "$DB_NAME" -At -c "SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MAX(timestamp))), 999999999)::bigint FROM cortana_events WHERE event_type='heartbeat_state_snapshot';" 2>/dev/null || echo "999999999")"
  if [[ "$LAST_AGE_SEC" =~ ^[0-9]+$ ]] && [ "$LAST_AGE_SEC" -ge "$SNAPSHOT_INTERVAL_SEC" ]; then
    META_SQL=$(python3 - "$VALIDATION_OUT" <<'PY'
import json,sys
print(json.dumps(json.loads(sys.argv[1])).replace("'", "''"))
PY
)
    $PSQL_BIN "$DB_NAME" -c "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('heartbeat_state_snapshot','heartbeat-validator','info','Heartbeat state shadow snapshot','${META_SQL}'::jsonb);" >/dev/null 2>&1 || true
  fi
fi

echo "$VALIDATION_OUT"
