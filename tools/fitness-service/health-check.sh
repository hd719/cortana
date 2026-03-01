#!/usr/bin/env bash
set -u

SERVICE_URL="http://127.0.0.1:3033"
SERVICE_PORT="3033"
BASE_DIR="$HOME/Developer/cortana-external"
WHOOP_TOKENS="$BASE_DIR/whoop_tokens.json"
TONAL_TOKENS="$BASE_DIR/tonal_tokens.json"
NOW_EPOCH=$(date +%s)

parse_epoch() {
  local raw="$1"
  local norm
  norm=$(printf '%s' "$raw" | sed -E 's/\.[0-9]+//' | sed -E 's/([+-][0-9]{2}):([0-9]{2})$/\1\2/')

  if date -u -d "$norm" +%s >/dev/null 2>&1; then
    date -u -d "$norm" +%s
    return 0
  fi

  if [[ "$norm" == *"Z" ]]; then
    date -j -u -f "%Y-%m-%dT%H:%M:%SZ" "$norm" +%s 2>/dev/null && return 0
  fi

  date -j -u -f "%Y-%m-%dT%H:%M:%S%z" "$norm" +%s 2>/dev/null
}

json_escape() {
  jq -Rn --arg s "$1" '$s'
}

check_status_port="fail"
check_msg_port="service not listening on port $SERVICE_PORT"
check_status_whoop_data="fail"
check_msg_whoop_data="/whoop/data unavailable"
check_status_whoop_token="fail"
check_msg_whoop_token="whoop token invalid"
check_status_tonal_token="fail"
check_msg_tonal_token="tonal token invalid"

is_port_open() {
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$SERVICE_PORT" >/dev/null 2>&1
    return $?
  fi
  (echo > /dev/tcp/127.0.0.1/"$SERVICE_PORT") >/dev/null 2>&1
}

# 1) service running on port 3033
if is_port_open; then
  check_status_port="pass"
  check_msg_port="service listening on port $SERVICE_PORT"
fi

# 2) whoop data endpoint + recovery payload
whoop_body_file=$(mktemp)
whoop_http=$(curl -sS --max-time 15 -o "$whoop_body_file" -w "%{http_code}" "$SERVICE_URL/whoop/data" 2>/dev/null || echo "000")
if [[ "$whoop_http" == "200" ]] && jq -e 'type=="object" and .recovery != null' "$whoop_body_file" >/dev/null 2>&1; then
  check_status_whoop_data="pass"
  check_msg_whoop_data="/whoop/data returned valid JSON with recovery"
else
  snippet=$(head -c 240 "$whoop_body_file" 2>/dev/null | tr '\n' ' ')
  check_msg_whoop_data="/whoop/data failed (http=$whoop_http, body=${snippet:-empty})"
fi
rm -f "$whoop_body_file"

# 3) whoop token exists + not expired
if [[ -f "$WHOOP_TOKENS" ]]; then
  whoop_exp=$(jq -r '.expires_at // empty' "$WHOOP_TOKENS" 2>/dev/null)
  whoop_access=$(jq -r '.access_token // empty' "$WHOOP_TOKENS" 2>/dev/null)
  whoop_refresh=$(jq -r '.refresh_token // empty' "$WHOOP_TOKENS" 2>/dev/null)
  if [[ -n "$whoop_exp" && -n "$whoop_access" && -n "$whoop_refresh" ]]; then
    whoop_exp_epoch=$(parse_epoch "$whoop_exp" 2>/dev/null || echo "")
    if [[ -n "$whoop_exp_epoch" && "$whoop_exp_epoch" -gt "$NOW_EPOCH" ]]; then
      check_status_whoop_token="pass"
      check_msg_whoop_token="whoop token valid (expires_at=$whoop_exp)"
    else
      check_msg_whoop_token="whoop token expired or unparsable (expires_at=$whoop_exp)"
    fi
  else
    check_msg_whoop_token="whoop token file missing required fields"
  fi
else
  check_msg_whoop_token="whoop_tokens.json missing"
fi

# 4) tonal token exists + valid
if [[ -f "$TONAL_TOKENS" ]]; then
  tonal_exp=$(jq -r '.expires_at // empty' "$TONAL_TOKENS" 2>/dev/null)
  tonal_id=$(jq -r '.id_token // empty' "$TONAL_TOKENS" 2>/dev/null)
  tonal_refresh=$(jq -r '.refresh_token // empty' "$TONAL_TOKENS" 2>/dev/null)
  if [[ -n "$tonal_exp" && -n "$tonal_id" && -n "$tonal_refresh" ]]; then
    tonal_exp_epoch=$(parse_epoch "$tonal_exp" 2>/dev/null || echo "")
    if [[ -n "$tonal_exp_epoch" && "$tonal_exp_epoch" -gt "$NOW_EPOCH" ]]; then
      check_status_tonal_token="pass"
      check_msg_tonal_token="tonal token valid (expires_at=$tonal_exp)"
    else
      check_msg_tonal_token="tonal token expired or unparsable (expires_at=$tonal_exp)"
    fi
  else
    check_msg_tonal_token="tonal token file missing required fields"
  fi
else
  check_msg_tonal_token="tonal_tokens.json missing"
fi

pass_count=0
[[ "$check_status_port" == "pass" ]] && pass_count=$((pass_count + 1))
[[ "$check_status_whoop_data" == "pass" ]] && pass_count=$((pass_count + 1))
[[ "$check_status_whoop_token" == "pass" ]] && pass_count=$((pass_count + 1))
[[ "$check_status_tonal_token" == "pass" ]] && pass_count=$((pass_count + 1))

overall="degraded"
exit_code=1
if [[ "$check_status_port" != "pass" ]]; then
  overall="down"
  exit_code=2
elif [[ "$pass_count" -eq 4 ]]; then
  overall="healthy"
  exit_code=0
fi

cat <<JSON
{
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "service": "fitness-service",
  "overall_status": "$overall",
  "checks": {
    "service_port": {"status": "$check_status_port", "message": $(json_escape "$check_msg_port")},
    "whoop_data": {"status": "$check_status_whoop_data", "message": $(json_escape "$check_msg_whoop_data")},
    "whoop_token": {"status": "$check_status_whoop_token", "message": $(json_escape "$check_msg_whoop_token")},
    "tonal_token": {"status": "$check_status_tonal_token", "message": $(json_escape "$check_msg_tonal_token")}
  }
}
JSON

exit "$exit_code"
