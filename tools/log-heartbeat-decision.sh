#!/usr/bin/env bash
set -euo pipefail

# Wrapper for heartbeat decision trace logging.
# Usage:
# ./log-heartbeat-decision.sh <check_name> <outcome> <reasoning> <confidence> [data_inputs_json]
#
# check_name examples:
#   email_triage, calendar, portfolio, fitness, weather, budget,
#   tech_news, mission_advancement, task_queue_execution, system_health

if [[ $# -lt 4 ]]; then
  echo "Usage: $0 <check_name> <outcome> <reasoning> <confidence> [data_inputs_json]" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DECISION_SCRIPT="$SCRIPT_DIR/log-decision.sh"

CHECK_NAME_RAW="$1"
OUTCOME="$2"
REASONING="$3"
CONFIDENCE="$4"
DATA_INPUTS_JSON="${5:-"{}"}"

if [[ ! -x "$LOG_DECISION_SCRIPT" ]]; then
  echo "Error: log-decision.sh not found or not executable at $LOG_DECISION_SCRIPT" >&2
  exit 1
fi

case "$OUTCOME" in
  success|skipped|fail) ;;
  *)
    echo "Error: outcome must be one of: success, skipped, fail" >&2
    exit 1
    ;;
esac

normalize() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | tr ' -' '__'
}

CHECK_NAME="$(normalize "$CHECK_NAME_RAW")"

ACTION_TYPE=""
ACTION_NAME=""

case "$CHECK_NAME" in
  email|email_triage)
    ACTION_TYPE="email_triage"
    ACTION_NAME="heartbeat_email_triage"
    ;;
  calendar|calendar_check|calendar_lookahead)
    ACTION_TYPE="calendar_check"
    ACTION_NAME="heartbeat_calendar_lookahead"
    ;;
  portfolio|portfolio_check|portfolio_alerts)
    ACTION_TYPE="portfolio_check"
    ACTION_NAME="heartbeat_portfolio_alerts"
    ;;
  fitness|fitness_check|fitness_checkin)
    ACTION_TYPE="fitness_check"
    ACTION_NAME="heartbeat_fitness_checkin"
    ;;
  weather|weather_check)
    ACTION_TYPE="weather_check"
    ACTION_NAME="heartbeat_weather"
    ;;
  budget|budget_check|api_budget|api_budget_check)
    ACTION_TYPE="budget_check"
    ACTION_NAME="heartbeat_api_budget_check"
    ;;
  tech_news|news|tech)
    ACTION_TYPE="tech_news"
    ACTION_NAME="heartbeat_tech_news"
    ;;
  mission|mission_task|mission_advancement)
    ACTION_TYPE="mission_task"
    ACTION_NAME="heartbeat_mission_advancement"
    ;;
  task_execution|task_queue_execution|task_queue)
    ACTION_TYPE="task_execution"
    ACTION_NAME="heartbeat_task_queue_execution"
    ;;
  system_health|health|watchlist|proactive_intelligence)
    ACTION_TYPE="system_health"
    ACTION_NAME="heartbeat_system_health"
    ;;
  *)
    echo "Error: unsupported check_name '$CHECK_NAME_RAW'" >&2
    echo "Supported: email_triage, calendar, portfolio, fitness, weather, budget, tech_news, mission_advancement, task_queue_execution, system_health" >&2
    exit 1
    ;;
esac

"$LOG_DECISION_SCRIPT" "heartbeat" "$ACTION_TYPE" "$ACTION_NAME" "$OUTCOME" "$REASONING" "$CONFIDENCE" "" "" "$DATA_INPUTS_JSON"
