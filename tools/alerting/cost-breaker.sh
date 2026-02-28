#!/usr/bin/env bash
set -euo pipefail

# Runaway session cost circuit breaker
#
# Features:
# - Reads current session usage from telegram usage handler
# - Computes spend, burn rate, and projected monthly spend
# - Applies thresholds:
#     * warning at >=50% budget before day 15
#     * alert at >=75% budget anytime
# - Flags runaway sub-agent sessions over token limit
# - Emits JSON summary
# - Writes ~/.openclaw/cost-alert.flag on critical threshold breach
# - Logs alerts to cortana_events (best effort)
# - Optional: --kill-runaway <sessionKey>

export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin"

DB="${CORTANA_DB:-cortana}"
USAGE_CMD=(node /Users/hd/openclaw/skills/telegram-usage/handler.js json)
SESSIONS_FILE="${OPENCLAW_SESSIONS_FILE:-$HOME/.openclaw/agents/main/sessions/sessions.json}"
FLAG_FILE="${COST_ALERT_FLAG_FILE:-$HOME/.openclaw/cost-alert.flag}"
MONTHLY_BUDGET_USD="${COST_BREAKER_MONTHLY_BUDGET_USD:-200}"
RUNAWAY_TOKEN_LIMIT="${RUNAWAY_TOKEN_LIMIT:-200000}"
TELEGRAM_GUARD="${TELEGRAM_GUARD:-/Users/hd/openclaw/tools/notifications/telegram-delivery-guard.sh}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-8171372724}"

KILL_SESSION_KEY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kill-runaway)
      KILL_SESSION_KEY="${2:-}"
      if [[ -z "$KILL_SESSION_KEY" ]]; then
        echo "--kill-runaway requires a sessionKey" >&2
        exit 2
      fi
      shift 2
      ;;
    --budget-usd)
      MONTHLY_BUDGET_USD="${2:-}"
      shift 2
      ;;
    --runaway-token-limit)
      RUNAWAY_TOKEN_LIMIT="${2:-}"
      shift 2
      ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --kill-runaway <sessionKey>      Attempt to kill runaway session process by key
  --budget-usd <amount>            Monthly budget in USD (default: ${MONTHLY_BUDGET_USD})
  --runaway-token-limit <tokens>   Runaway token limit (default: ${RUNAWAY_TOKEN_LIMIT})
  -h, --help                       Show help
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

sql_escape() {
  echo "$1" | sed "s/'/''/g"
}

log_event() {
  local sev="$1" msg="$2" meta="${3:-{}}"
  local esc_msg esc_meta
  esc_msg="$(sql_escape "$msg")"
  esc_meta="$(sql_escape "$meta")"
  psql "$DB" -c "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('cost_breaker', 'cost-breaker.sh', '${sev}', '${esc_msg}', '${esc_meta}');" >/dev/null 2>&1 || true
}

send_telegram_alert() {
  local msg="$1"
  if [[ -x "$TELEGRAM_GUARD" ]]; then
    "$TELEGRAM_GUARD" "$msg" "$TELEGRAM_CHAT_ID" >/dev/null 2>&1 || true
  else
    log_event "warning" "Telegram guard missing; alert not sent" "$(jq -n --arg guard "$TELEGRAM_GUARD" '{guard:$guard}')"
  fi
}

kill_runaway_session() {
  local key="$1"
  local killed=0

  # Best effort 1: openclaw subagents (older/newer installs may or may not expose this command)
  if openclaw subagents kill "$key" >/dev/null 2>&1; then
    killed=1
  else
    # Best effort 2: kill local processes matching session key
    local pids
    pids="$(pgrep -f "$key" || true)"
    if [[ -n "$pids" ]]; then
      while IFS= read -r pid; do
        [[ -z "$pid" ]] && continue
        kill "$pid" >/dev/null 2>&1 || true
      done <<< "$pids"
      killed=1
    fi
  fi

  local out
  out="$(jq -n --arg key "$key" --argjson killed "$killed" '{action:"kill_runaway",sessionKey:$key,killed:($killed==1)}')"

  if [[ "$killed" -eq 1 ]]; then
    log_event "warning" "Runaway session kill executed" "$(jq -n --arg key "$key" '{sessionKey:$key,action:"kill_runaway",result:"killed"}')"
  else
    log_event "warning" "Runaway session kill requested but no process found" "$(jq -n --arg key "$key" '{sessionKey:$key,action:"kill_runaway",result:"not_found"}')"
  fi

  echo "$out"
  exit 0
}

if [[ -n "$KILL_SESSION_KEY" ]]; then
  kill_runaway_session "$KILL_SESSION_KEY"
fi

usage_raw="$("${USAGE_CMD[@]}" 2>&1 || true)"

# Handler can print non-JSON lines before JSON; extract the first JSON object block.
usage_json="$(printf '%s\n' "$usage_raw" | python3 -c 'import sys; s=sys.stdin.read(); a=s.find("{"); b=s.rfind("}"); print("{}" if a==-1 or b==-1 or b<=a else s[a:b+1])')"

# Pull usage fields with defaults.
input_tokens="$(printf '%s' "$usage_json" | jq -r '.totalTokens.input // 0')"
output_tokens="$(printf '%s' "$usage_json" | jq -r '.totalTokens.output // 0')"
model="$(printf '%s' "$usage_json" | jq -r '.model // "unknown"')"
provider="$(printf '%s' "$usage_json" | jq -r '.provider // "unknown"')"

total_tokens=$((input_tokens + output_tokens))

# Simple model pricing map (USD per 1k tokens): input,output
in_rate="0.01"
out_rate="0.03"
model_lc="$(printf '%s' "$model" | tr '[:upper:]' '[:lower:]')"
case "$model_lc" in
  *"haiku"*) in_rate="0.0008"; out_rate="0.004" ;;
  *"sonnet"*) in_rate="0.003"; out_rate="0.015" ;;
  *"opus"*) in_rate="0.015"; out_rate="0.075" ;;
  *"gpt-4.1-mini"*) in_rate="0.0006"; out_rate="0.0024" ;;
  *"gpt-4.1"*|*"gpt-4o"*) in_rate="0.005"; out_rate="0.015" ;;
  *"gpt-5"*|*"codex"*) in_rate="0.01"; out_rate="0.03" ;;
esac

current_spend="$(awk -v i="$input_tokens" -v o="$output_tokens" -v ir="$in_rate" -v or="$out_rate" 'BEGIN { printf "%.6f", (i/1000.0)*ir + (o/1000.0)*or }')"

# Date math for burn rate / projection
now_day="$(date +%d | sed 's/^0*//')"
days_in_month="$(date -v+1m -v1d -v-1d +%d 2>/dev/null || python3 - <<'PY'
import datetime
now=datetime.datetime.now()
if now.month==12:
  nm=datetime.datetime(now.year+1,1,1)
else:
  nm=datetime.datetime(now.year,now.month+1,1)
print((nm-datetime.timedelta(days=1)).day)
PY
)"

if [[ "${now_day:-0}" -le 0 ]]; then now_day=1; fi

burn_rate="$(awk -v spend="$current_spend" -v day="$now_day" 'BEGIN { printf "%.6f", (day>0?spend/day:0) }')"
projected_monthly="$(awk -v burn="$burn_rate" -v dim="$days_in_month" 'BEGIN { printf "%.6f", burn*dim }')"
pct_budget="$(awk -v spend="$current_spend" -v b="$MONTHLY_BUDGET_USD" 'BEGIN { if (b<=0) printf "0.00"; else printf "%.2f", (spend/b)*100.0 }')"

warn_pre_midmonth=false
alert_75_anytime=false
critical=false

# runaway detection from session store (best effort)
runaway_sessions='[]'
if [[ -f "$SESSIONS_FILE" ]]; then
  runaway_sessions="$(jq -c --argjson lim "$RUNAWAY_TOKEN_LIMIT" '
    to_entries
    | map(select((.key | test("subagent|agent:main:subagent"; "i")) and ((.value.totalTokens // ((.value.inputTokens // 0) + (.value.outputTokens // 0))) > $lim)))
    | map({sessionKey:.key,totalTokens:(.value.totalTokens // ((.value.inputTokens // 0) + (.value.outputTokens // 0))),updatedAt:(.value.updatedAt // null)})
  ' "$SESSIONS_FILE" 2>/dev/null || echo '[]')"
fi

runaway_count="$(printf '%s' "$runaway_sessions" | jq -r 'length')"

if awk -v p="$pct_budget" 'BEGIN { exit !(p >= 50.0) }' && [[ "$now_day" -lt 15 ]]; then
  warn_pre_midmonth=true
fi
if awk -v p="$pct_budget" 'BEGIN { exit !(p >= 75.0) }'; then
  alert_75_anytime=true
  critical=true
fi
if [[ "$runaway_count" -gt 0 ]]; then
  critical=true
fi

breaches='[]'
if [[ "$warn_pre_midmonth" == "true" ]]; then
  breaches="$(printf '%s' "$breaches" | jq '. + [{"id":"warn_50_pre_midmonth","severity":"warning"}]')"
fi
if [[ "$alert_75_anytime" == "true" ]]; then
  breaches="$(printf '%s' "$breaches" | jq '. + [{"id":"alert_75_anytime","severity":"critical"}]')"
fi
if [[ "$runaway_count" -gt 0 ]]; then
  breaches="$(printf '%s' "$breaches" | jq --argjson lim "$RUNAWAY_TOKEN_LIMIT" '. + [{"id":"runaway_subagent_tokens","severity":"critical","limitTokens":$lim}]')"
fi

if [[ "$critical" == "true" ]]; then
  mkdir -p "$(dirname "$FLAG_FILE")"
  jq -n \
    --arg ts "$(date -Iseconds)" \
    --arg pct "$pct_budget" \
    --argjson breaches "$breaches" \
    '{triggeredAt:$ts,pctBudgetUsed:($pct|tonumber),breaches:$breaches}' > "$FLAG_FILE"

  log_event "error" "Cost breaker critical threshold breached" "$(jq -n \
    --arg model "$model" \
    --arg provider "$provider" \
    --arg pct "$pct_budget" \
    --arg spend "$current_spend" \
    --arg proj "$projected_monthly" \
    --argjson runaway "$runaway_sessions" \
    --argjson breaches "$breaches" \
    '{model:$model,provider:$provider,pctBudgetUsed:($pct|tonumber),currentSpend:($spend|tonumber),projectedMonthly:($proj|tonumber),runawaySessions:$runaway,breaches:$breaches}')"

  send_telegram_alert "🚨 Cost breaker tripped: ${pct_budget}% of monthly budget used (\$${current_spend} so far, projected \$${projected_monthly}). Breaches: $(echo "$breaches" | jq -r 'map(.id) | join(", ")')."
else
  rm -f "$FLAG_FILE" >/dev/null 2>&1 || true
fi

if [[ "$warn_pre_midmonth" == "true" ]]; then
  log_event "warning" "Cost breaker warning threshold breached (50% before mid-month)" "$(jq -n --arg pct "$pct_budget" --arg day "$now_day" '{pctBudgetUsed:($pct|tonumber),dayOfMonth:($day|tonumber)}')"
fi
if [[ "$alert_75_anytime" == "true" ]]; then
  log_event "error" "Cost breaker alert threshold breached (75% anytime)" "$(jq -n --arg pct "$pct_budget" '{pctBudgetUsed:($pct|tonumber)}')"
fi

jq -n \
  --arg ts "$(date -Iseconds)" \
  --arg model "$model" \
  --arg provider "$provider" \
  --arg spend "$current_spend" \
  --arg proj "$projected_monthly" \
  --arg burn "$burn_rate" \
  --arg pct "$pct_budget" \
  --argjson budget "$MONTHLY_BUDGET_USD" \
  --argjson day "$now_day" \
  --argjson dim "$days_in_month" \
  --argjson runawayLimit "$RUNAWAY_TOKEN_LIMIT" \
  --argjson input "$input_tokens" \
  --argjson output "$output_tokens" \
  --argjson total "$total_tokens" \
  --argjson breaches "$breaches" \
  --argjson runaway "$runaway_sessions" \
  --arg flag "$FLAG_FILE" \
  --argjson criticalBool "$critical" \
  '{
    timestamp:$ts,
    model:$model,
    provider:$provider,
    monthlyBudgetUsd:$budget,
    usage:{inputTokens:$input,outputTokens:$output,totalTokens:$total},
    spend:{
      currentUsd:($spend|tonumber),
      burnRateUsdPerDay:($burn|tonumber),
      projectedMonthlyUsd:($proj|tonumber),
      pctOfBudget:($pct|tonumber)
    },
    period:{dayOfMonth:$day,daysInMonth:$dim},
    thresholds:{
      warning50BeforeMidMonth:{enabled:true,breached:(($breaches|map(select(.id=="warn_50_pre_midmonth"))|length)>0)},
      alert75Anytime:{enabled:true,breached:(($breaches|map(select(.id=="alert_75_anytime"))|length)>0)},
      runawaySessionTokens:{limit:$runawayLimit,breached:(($breaches|map(select(.id=="runaway_subagent_tokens"))|length)>0)}
    },
    runawaySessions:$runaway,
    breachedThresholds:$breaches,
    criticalBreach:$criticalBool,
    flagFile:(if $criticalBool then $flag else null end)
  }'
