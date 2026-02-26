#!/usr/bin/env bash
set -euo pipefail

PSQL_BIN="${PSQL_BIN:-/opt/homebrew/opt/postgresql@17/bin/psql}"
DB_NAME="${DB_NAME:-cortana}"
SOURCE="spawn-retry-engine"
ANALYZE_HOURS="${ANALYZE_HOURS:-24}"
ANALYZE_LIMIT="${ANALYZE_LIMIT:-100}"

MODEL_FULL_DEFAULT="openai-codex/gpt-5.3-codex"
TIMEOUT_MULTIPLIER="${TIMEOUT_MULTIPLIER:-2}"
TIMEOUT_FALLBACK_SEC="${TIMEOUT_FALLBACK_SEC:-1800}"
RATE_LIMIT_BACKOFF_BASE="${RATE_LIMIT_BACKOFF_BASE:-2}"
RATE_LIMIT_BACKOFF_CAP="${RATE_LIMIT_BACKOFF_CAP:-300}"

json_escape() {
  python3 - <<'PY' "$1"
import json,sys
print(json.dumps(sys.argv[1]))
PY
}

emit_json() {
  printf '%s\n' "$1"
}

db_json() {
  "$PSQL_BIN" "$DB_NAME" -X -qAt -c "$1"
}

log_event() {
  local event_type="$1"
  local severity="$2"
  local message="$3"
  local metadata_json="$4"
  local esc_message
  esc_message="${message//\'/\'\'}"
  "$PSQL_BIN" "$DB_NAME" -X -qAt -c "
    INSERT INTO cortana_events (event_type, source, severity, message, metadata)
    VALUES ('${event_type//\'/\'\'}', '$SOURCE', '${severity//\'/\'\'}', '$esc_message', '${metadata_json//\'/\'\'}'::jsonb)
    RETURNING id;
  " 2>/dev/null || true
}

classify_pattern() {
  local haystack="${1,,}"

  if [[ "$haystack" == *"model routing"* ]] || [[ "$haystack" == *"model not allowed"* ]] || [[ "$haystack" == *"invalid model"* ]] || [[ "$haystack" == *"unknown model"* ]] || [[ "$haystack" == *"full model id"* ]] || [[ "$haystack" == *"shorthand"* ]]; then
    printf 'model_routing_error'
  elif [[ "$haystack" == *"timed out"* ]] || [[ "$haystack" == *"timeout"* ]] || [[ "$haystack" == *"deadline exceeded"* ]] || [[ "$haystack" == *"etimedout"* ]]; then
    printf 'timeout'
  elif [[ "$haystack" == *"out of memory"* ]] || [[ "$haystack" == *" oom "* ]] || [[ "$haystack" == oom:* ]] || [[ "$haystack" == *"killed process"* ]] || [[ "$haystack" == *"cannot allocate memory"* ]]; then
    printf 'oom'
  elif [[ "$haystack" == *"rate limit"* ]] || [[ "$haystack" == *"429"* ]] || [[ "$haystack" == *"too many requests"* ]] || [[ "$haystack" == *"quota exceeded"* ]]; then
    printf 'rate_limit'
  else
    printf 'unknown'
  fi
}

recommendation_for() {
  case "$1" in
    model_routing_error) printf 'Retry with full model path (e.g., openai-codex/gpt-5.3-codex)' ;;
    timeout) printf 'Retry with extended timeout (--timeout increased)' ;;
    oom) printf 'Retry with lighter workload/smaller prompt or alternate model' ;;
    rate_limit) printf 'Retry with exponential backoff before spawn' ;;
    *) printf 'Collect more context; retry manually with explicit model/timeout' ;;
  esac
}

normalize_model() {
  local m="${1:-}"
  case "$m" in
    codex|gpt-5.3-codex|openai/gpt-5.3-codex) printf 'openai-codex/gpt-5.3-codex' ;;
    gpt-5.1|openai/gpt-5.1) printf 'openai-codex/gpt-5.1' ;;
    claude-opus-4-6|opus-4-6|anthropic/claude-opus-4-6) printf 'anthropic/claude-opus-4-6' ;;
    "") printf '%s' "$MODEL_FULL_DEFAULT" ;;
    *) printf '%s' "$m" ;;
  esac
}

analyze() {
  local hours="$ANALYZE_HOURS"
  local limit="$ANALYZE_LIMIT"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --hours) hours="${2:-$ANALYZE_HOURS}"; shift 2 ;;
      --limit) limit="${2:-$ANALYZE_LIMIT}"; shift 2 ;;
      *)
        emit_json '{"ok":false,"error":"unknown argument for analyze"}'
        return 1
        ;;
    esac
  done

  local payload
  payload="$(db_json "
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)::text
    FROM (
      SELECT id, timestamp, source, severity, message, metadata
      FROM cortana_events
      WHERE event_type='spawn_failed'
        AND timestamp >= NOW() - ('${hours} hours')::interval
      ORDER BY id DESC
      LIMIT ${limit}
    ) t;
  ")"

  FAILURES_JSON="$payload" python3 - <<'PY'
import json, os
rows = json.loads(os.environ.get("FAILURES_JSON", "[]"))

patterns = {
    "model_routing_error": {"count": 0, "event_ids": []},
    "timeout": {"count": 0, "event_ids": []},
    "oom": {"count": 0, "event_ids": []},
    "rate_limit": {"count": 0, "event_ids": []},
    "unknown": {"count": 0, "event_ids": []},
}

recs = {
    "model_routing_error": "Retry with full model path (e.g., openai-codex/gpt-5.3-codex)",
    "timeout": "Retry with extended timeout (--timeout increased)",
    "oom": "Retry with lighter workload/smaller prompt or alternate model",
    "rate_limit": "Retry with exponential backoff before spawn",
    "unknown": "Collect more context; retry manually with explicit model/timeout",
}

def classify(text: str) -> str:
    t = (text or "").lower()
    if any(k in t for k in ["model routing", "model not allowed", "invalid model", "unknown model", "full model id", "shorthand"]):
        return "model_routing_error"
    if any(k in t for k in ["timed out", "timeout", "deadline exceeded", "etimedout"]):
        return "timeout"
    if any(k in t for k in ["out of memory", " oom ", "oom:", "killed process", "cannot allocate memory"]):
        return "oom"
    if any(k in t for k in ["rate limit", "429", "too many requests", "quota exceeded"]):
        return "rate_limit"
    return "unknown"

for r in rows:
    text = f"{r.get('message','')} {json.dumps(r.get('metadata') or {})}"
    p = classify(text)
    patterns[p]["count"] += 1
    patterns[p]["event_ids"].append(r.get("id"))

out = {
    "ok": True,
    "operation": "analyze",
    "total_failures": len(rows),
    "patterns": {
        k: {
            "count": v["count"],
            "event_ids": v["event_ids"][:20],
            "recommendation": recs[k],
        }
        for k, v in patterns.items()
    },
}
print(json.dumps(out, separators=(",", ":")))
PY
}

retry_event() {
  local event_id="${1:-}"
  if [[ -z "$event_id" ]]; then
    emit_json '{"ok":false,"error":"event_id is required"}'
    return 1
  fi

  local row
  row="$(db_json "
    SELECT COALESCE(row_to_json(t), '{}'::json)::text
    FROM (
      SELECT id, timestamp, source, severity, message, metadata
      FROM cortana_events
      WHERE id = ${event_id}
        AND event_type = 'spawn_failed'
      LIMIT 1
    ) t;
  ")"

  if [[ -z "$row" || "$row" == "{}" ]]; then
    emit_json "{\"ok\":false,\"error\":\"spawn_failed event not found\",\"event_id\":${event_id}}"
    return 1
  fi

  local parsed
  parsed="$(EVENT_JSON="$row" python3 - <<'PY'
import json, os, re

event = json.loads(os.environ["EVENT_JSON"])
meta = event.get("metadata") or {}
message = event.get("message") or ""
text = f"{message} {json.dumps(meta)}".lower()

def classify(t: str) -> str:
    if any(k in t for k in ["model routing", "model not allowed", "invalid model", "unknown model", "full model id", "shorthand"]):
        return "model_routing_error"
    if any(k in t for k in ["timed out", "timeout", "deadline exceeded", "etimedout"]):
        return "timeout"
    if any(k in t for k in ["out of memory", " oom ", "oom:", "killed process", "cannot allocate memory"]):
        return "oom"
    if any(k in t for k in ["rate limit", "429", "too many requests", "quota exceeded"]):
        return "rate_limit"
    return "unknown"

pattern = classify(text)
cmd = (
    meta.get("retry_command")
    or meta.get("spawn_command")
    or meta.get("command")
    or ""
)

if isinstance(cmd, list):
    cmd = " ".join(str(x) for x in cmd)

model = str(meta.get("model") or "")
timeout = meta.get("timeout") or meta.get("timeout_s") or meta.get("timeout_sec")

print(json.dumps({
    "pattern": pattern,
    "command": cmd,
    "model": model,
    "timeout": timeout,
}, separators=(",", ":")))
PY
)"

  local pattern command model timeout
  pattern="$(PARSED_JSON="$parsed" python3 - <<'PY'
import json,os
p=json.loads(os.environ['PARSED_JSON'])
print(p.get('pattern','unknown'))
PY
)"
  command="$(PARSED_JSON="$parsed" python3 - <<'PY'
import json,os
p=json.loads(os.environ['PARSED_JSON'])
print(p.get('command',''))
PY
)"
  model="$(PARSED_JSON="$parsed" python3 - <<'PY'
import json,os
p=json.loads(os.environ['PARSED_JSON'])
print(p.get('model',''))
PY
)"
  timeout="$(PARSED_JSON="$parsed" python3 - <<'PY'
import json,os
p=json.loads(os.environ['PARSED_JSON'])
t=p.get('timeout')
print('' if t is None else t)
PY
)"

  if [[ -z "$command" ]]; then
    local rec
    rec="$(recommendation_for "$pattern")"
    emit_json "{\"ok\":false,\"operation\":\"retry\",\"event_id\":${event_id},\"pattern\":\"${pattern}\",\"error\":\"No spawn command found in metadata (retry_command/spawn_command/command)\",\"recommendation\":\"${rec}\"}"
    return 1
  fi

  local fix_applied="none"

  if [[ "$pattern" == "model_routing_error" ]]; then
    local full_model
    full_model="$(normalize_model "$model")"
    if [[ -z "$full_model" ]]; then
      full_model="$MODEL_FULL_DEFAULT"
    fi

    if [[ "$command" == *"--model "* ]]; then
      command="$(python3 - <<'PY' "$command" "$full_model"
import re,sys
cmd=sys.argv[1]
model=sys.argv[2]
print(re.sub(r'--model\s+\S+', f'--model {model}', cmd, count=1))
PY
)"
    else
      command="$command --model $full_model"
    fi
    fix_applied="model_full_path"

  elif [[ "$pattern" == "timeout" ]]; then
    local new_timeout
    if [[ "$timeout" =~ ^[0-9]+$ ]]; then
      new_timeout="$(( timeout * TIMEOUT_MULTIPLIER ))"
    else
      new_timeout="$TIMEOUT_FALLBACK_SEC"
    fi

    if [[ "$command" == *"--timeout "* ]]; then
      command="$(python3 - <<'PY' "$command" "$new_timeout"
import re,sys
cmd=sys.argv[1]
sec=sys.argv[2]
print(re.sub(r'--timeout\s+\d+', f'--timeout {sec}', cmd, count=1))
PY
)"
    else
      command="$command --timeout $new_timeout"
    fi
    fix_applied="timeout_extended"

  elif [[ "$pattern" == "rate_limit" ]]; then
    local prev_retries
    prev_retries="$(db_json "
      SELECT COUNT(*)
      FROM cortana_events
      WHERE event_type = 'spawn_retry'
        AND (metadata->>'original_event_id')::bigint = ${event_id};
    " | tr -d '[:space:]')"

    if [[ -z "$prev_retries" || ! "$prev_retries" =~ ^[0-9]+$ ]]; then
      prev_retries=0
    fi

    local backoff=$(( RATE_LIMIT_BACKOFF_BASE ** prev_retries ))
    if (( backoff > RATE_LIMIT_BACKOFF_CAP )); then
      backoff="$RATE_LIMIT_BACKOFF_CAP"
    fi

    sleep "$backoff"
    fix_applied="rate_limit_backoff_${backoff}s"
  fi

  local rc=0
  local out
  out="$(bash -lc "$command" 2>&1)" || rc=$?

  local out_json
  out_json="$(python3 - <<'PY' "$out"
import json,sys
print(json.dumps(sys.argv[1]))
PY
)"

  local retry_metadata
  retry_metadata="$(python3 - <<'PY' "$event_id" "$pattern" "$fix_applied" "$command" "$rc" "$out"
import json,sys
print(json.dumps({
  "original_event_id": int(sys.argv[1]),
  "pattern": sys.argv[2],
  "fix_applied": sys.argv[3],
  "retry_command": sys.argv[4],
  "retry_exit_code": int(sys.argv[5]),
  "retry_output": sys.argv[6][:4000],
}, separators=(",", ":")))
PY
)"

  local retry_event_id
  retry_event_id="$(log_event "spawn_retry" "$([[ "$rc" -eq 0 ]] && echo info || echo error)" "Spawn retry attempted for event ${event_id}" "$retry_metadata" | tr -d '[:space:]' || true)"

  if [[ "$rc" -ne 0 ]]; then
    local failure_meta
    failure_meta="$(python3 - <<'PY' "$event_id" "$pattern" "$command" "$rc" "$out"
import json,sys
print(json.dumps({
  "original_event_id": int(sys.argv[1]),
  "retry_pattern": sys.argv[2],
  "spawn_command": sys.argv[3],
  "retry_exit_code": int(sys.argv[4]),
  "retry_output": sys.argv[5][:4000],
}, separators=(",", ":")))
PY
)"
    log_event "spawn_failed" "error" "Spawn retry failed for event ${event_id}" "$failure_meta" >/dev/null || true
  fi

  emit_json "{\"ok\":$([[ "$rc" -eq 0 ]] && echo true || echo false),\"operation\":\"retry\",\"event_id\":${event_id},\"pattern\":\"${pattern}\",\"fix_applied\":\"${fix_applied}\",\"retry_event_id\":${retry_event_id:-null},\"exit_code\":${rc},\"retry_command\":$(json_escape "$command"),\"output\":${out_json}}"

  return "$rc"
}

usage() {
  cat <<'EOF'
Usage:
  retry-engine.sh analyze [--hours 24] [--limit 100]
  retry-engine.sh retry <event_id>

Environment:
  PSQL_BIN=/opt/homebrew/opt/postgresql@17/bin/psql
  DB_NAME=cortana

Output: JSON for all operations.
EOF
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    analyze)
      shift
      analyze "$@"
      ;;
    retry)
      shift
      retry_event "${1:-}"
      ;;
    -h|--help|help|"")
      usage
      ;;
    *)
      emit_json '{"ok":false,"error":"unknown command"}'
      return 1
      ;;
  esac
}

main "$@"
