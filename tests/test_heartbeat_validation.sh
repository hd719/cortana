#!/usr/bin/env bash
set -euo pipefail
assert_true(){ "$@" || { echo "ASSERT FAILED: $*"; exit 1; }; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
SCRIPT=/Users/hd/openclaw/tools/heartbeat/validate-heartbeat-state.sh

make_valid() {
  python3 - <<'PY' "$1"
import json,time,sys
now=int(time.time()*1000)
checks={k:{"lastChecked":now} for k in ["email","calendar","watchlist","tasks","portfolio","marketIntel","techNews","weather","fitness","apiBudget","mission","cronDelivery"]}
json.dump({"version":2,"lastChecks":checks,"lastRemediationAt":now,"subagentWatchdog":{"lastRun":now,"lastLogged":{}}}, open(sys.argv[1],'w'))
PY
}

state="$TMP/state.json"
make_valid "$state"
out="$(HEARTBEAT_STATE_FILE="$state" PSQL_BIN=/nope DB_NAME=x bash "$SCRIPT")"
assert_true echo "$out" | grep -q '"action": "validated"\|"action":"validated"'
# drive backup rotation to .bak.1/.bak.2/.bak.3
for _ in 1 2 3; do
  make_valid "$state"
  HEARTBEAT_STATE_FILE="$state" PSQL_BIN=/nope DB_NAME=x bash "$SCRIPT" >/dev/null
 done
assert_true test -f "$state.bak.1"
assert_true test -f "$state.bak.2"
assert_true test -f "$state.bak.3"

# corrupt -> restore from backup
printf '{bad json' > "$state"
make_valid "$state.bak.1"
out2="$(HEARTBEAT_STATE_FILE="$state" PSQL_BIN=/nope DB_NAME=x bash "$SCRIPT")"
assert_true echo "$out2" | grep -q 'restored_from_backup'

# stale timestamp -> flagged and default reinit when no valid backups
python3 - <<'PY' "$state"
import json,time,sys
stale=int((time.time()-49*3600)*1000)
checks={k:{"lastChecked":stale} for k in ["email","calendar","watchlist","tasks","portfolio","marketIntel","techNews","weather","fitness","apiBudget","mission","cronDelivery"]}
json.dump({"version":2,"lastChecks":checks,"lastRemediationAt":stale,"subagentWatchdog":{"lastRun":stale,"lastLogged":{}}}, open(sys.argv[1],'w'))
PY
rm -f "$state".bak.1 "$state".bak.2 "$state".bak.3
out3="$(HEARTBEAT_STATE_FILE="$state" PSQL_BIN=/nope DB_NAME=x bash "$SCRIPT")"
assert_true echo "$out3" | grep -q 'reinitialized_default'
assert_true echo "$out3" | grep -q 'invalidReason'

echo "PASS: heartbeat-validation"
