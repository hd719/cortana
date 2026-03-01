#!/usr/bin/env bash
set -u

BASE_DIR="$HOME/Developer/cortana-external"
WHOOP_TOKENS="$BASE_DIR/whoop_tokens.json"
TONAL_TOKENS="$BASE_DIR/tonal_tokens.json"
WARN_WINDOW=3600
NOW_EPOCH=$(date +%s)
warnings=0

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

check_token() {
  local name="$1"
  local path="$2"
  local token_field="$3"

  if [[ ! -f "$path" ]]; then
    echo "WARN [$name] token file missing: $path"
    warnings=$((warnings + 1))
    return
  fi

  local token exp exp_epoch remaining
  token=$(jq -r --arg field "$token_field" '.[$field] // empty' "$path" 2>/dev/null)
  exp=$(jq -r '.expires_at // empty' "$path" 2>/dev/null)

  if [[ -z "$token" || -z "$exp" ]]; then
    echo "WARN [$name] token missing required fields (token/expires_at)"
    warnings=$((warnings + 1))
    return
  fi

  exp_epoch=$(parse_epoch "$exp" 2>/dev/null || echo "")
  if [[ -z "$exp_epoch" ]]; then
    echo "WARN [$name] expires_at unparsable: $exp"
    warnings=$((warnings + 1))
    return
  fi

  remaining=$((exp_epoch - NOW_EPOCH))
  if [[ "$remaining" -le 0 ]]; then
    echo "WARN [$name] token expired at $exp"
    warnings=$((warnings + 1))
  elif [[ "$remaining" -le "$WARN_WINDOW" ]]; then
    echo "WARN [$name] token expires within 1h (${remaining}s remaining, expires_at=$exp)"
    warnings=$((warnings + 1))
  else
    echo "OK   [$name] token healthy (${remaining}s remaining)"
  fi
}

check_token "whoop" "$WHOOP_TOKENS" "access_token"
check_token "tonal" "$TONAL_TOKENS" "id_token"

if [[ "$warnings" -gt 0 ]]; then
  echo "SUMMARY warnings=$warnings"
  exit 1
fi

echo "SUMMARY warnings=0"
exit 0
