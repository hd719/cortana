#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

issues=()

tonal_health="$(curl -sf --max-time 10 http://127.0.0.1:3033/tonal/health 2>/dev/null || true)"
if [[ -n "$tonal_health" ]]; then
  if ! jq -e '.status == "healthy" and .authenticated == true and .refresh_token_present == true' <<<"$tonal_health" >/dev/null 2>&1; then
    issues+=("tonal: AUTH DEGRADED")
  fi
else
  tonal_tokens="$HOME/Developer/cortana-external/tonal_tokens.json"
  if [[ -f "$tonal_tokens" ]]; then
    if ! jq -e '(.id_token // "" | length > 0) and (.refresh_token // "" | length > 0) and (.expires_at // "" | length > 0)' "$tonal_tokens" >/dev/null 2>&1; then
      issues+=("tonal: NO TOKEN")
    elif ! node -e 'const fs = require("fs"); const token = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.exit(Date.parse(token.expires_at) > Date.now() ? 0 : 1);' "$tonal_tokens" >/dev/null 2>&1; then
      issues+=("tonal: TOKEN EXPIRED")
    fi
  else
    issues+=("tonal: TOKEN FILE MISSING")
  fi
fi

if pg_isready -d cortana -q >/dev/null 2>&1; then
  :
else
  issues+=("postgres: DOWN")
fi

if curl -sf http://127.0.0.1:18789/ >/dev/null 2>&1; then
  :
else
  issues+=("gateway: DOWN")
fi

disk_pct="$(df -h / | awk 'NR==2 {print $5}')"
disk_num="${disk_pct%%%}"
if [[ -n "$disk_num" ]] && [[ "$disk_num" =~ ^[0-9]+$ ]] && (( disk_num >= 90 )); then
  issues+=("disk: ${disk_pct}")
fi

cleaned=0
while IFS= read -r file; do
  [[ -n "$file" ]] || continue
  rm -f "$file"
  cleaned=$((cleaned + 1))
done < <(find "$HOME/.openclaw/agents/main/sessions" -name '*.jsonl' -size +400k 2>/dev/null || true)

if (( cleaned > 0 )); then
  if command -v psql >/dev/null 2>&1; then
    psql cortana -c "INSERT INTO cortana_events (event_type, source, severity, message) VALUES ('auto_heal', 'immune_scan', 'info', 'Cleaned oversized session');" >/dev/null 2>&1 || true
  fi
  issues+=("sessions: cleaned ${cleaned} oversized")
fi

if (( ${#issues[@]} == 0 )); then
  exit 0
fi

printf '%s\n' "${issues[@]:0:5}"
