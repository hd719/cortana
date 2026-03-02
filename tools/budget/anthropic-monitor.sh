#!/usr/bin/env bash
set -euo pipefail

# Anthropic budget monitor
# - Estimates today's Anthropic spend from OpenClaw session tokens (deduped by sessionId)
# - Extrapolates daily burn rate
# - Triggers alert conditions for low remaining credits and high burn

LOW_BALANCE_THRESHOLD="${LOW_BALANCE_THRESHOLD:-20}"
HIGH_BURN_THRESHOLD="${HIGH_BURN_THRESHOLD:-25}"
SESSIONS_PATH="${SESSIONS_PATH:-$HOME/.openclaw/agents/main/sessions/sessions.json}"
TZ_NAME="${TZ_NAME:-America/New_York}"

# Optional explicit remaining credits input:
#   --remaining 42.5
# or environment:
#   ANTHROPIC_CREDITS_REMAINING=42.5
REMAINING="${ANTHROPIC_CREDITS_REMAINING:-}"

if [[ "${1:-}" == "--remaining" ]]; then
  REMAINING="${2:-}"
fi

if [[ ! -f "$SESSIONS_PATH" ]]; then
  echo "ERROR: sessions file not found at $SESSIONS_PATH"
  exit 1
fi

python3 - "$SESSIONS_PATH" "$TZ_NAME" "$LOW_BALANCE_THRESHOLD" "$HIGH_BURN_THRESHOLD" "$REMAINING" <<'PY'
import json, sys, datetime
from collections import defaultdict

sessions_path, tz_name, low_bal, high_burn, remaining = sys.argv[1:6]
low_bal = float(low_bal)
high_burn = float(high_burn)
remaining_val = None
if remaining not in (None, '', 'null'):
    try:
        remaining_val = float(remaining)
    except Exception:
        pass

try:
    from zoneinfo import ZoneInfo
    tz = ZoneInfo(tz_name)
except Exception:
    tz = datetime.timezone.utc

with open(sessions_path, 'r') as f:
    data = json.load(f)

now = datetime.datetime.now(tz)
today = now.date()

# Opus pricing requested for estimation
IN_PRICE = 15.0 / 1_000_000.0
OUT_PRICE = 75.0 / 1_000_000.0

by_sid = {}
for key, v in data.items():
    model = (v.get('model') or '').lower()
    if 'claude' not in model and 'anthropic' not in model:
        continue
    ts = v.get('updatedAt')
    if not ts:
        continue
    dt = datetime.datetime.fromtimestamp(ts / 1000.0, tz=tz)
    if dt.date() != today:
        continue

    sid = v.get('sessionId') or key
    rec = {
        'key': key,
        'sid': sid,
        'model': v.get('model') or 'unknown',
        'updated': dt.isoformat(),
        'input': int(v.get('inputTokens') or 0),
        'cache_read': int(v.get('cacheRead') or 0),
        'cache_write': int(v.get('cacheWrite') or 0),
        'output': int(v.get('outputTokens') or 0),
        'total': int(v.get('totalTokens') or 0),
    }

    # Deduplicate run/session alias rows: keep highest-token view per session
    prev = by_sid.get(sid)
    if prev is None or rec['total'] > prev['total']:
        by_sid[sid] = rec

rows = list(by_sid.values())

for r in rows:
    in_tokens = r['input'] + r['cache_read'] + r['cache_write']
    out_tokens = r['output']
    r['est_cost'] = in_tokens * IN_PRICE + out_tokens * OUT_PRICE

rows.sort(key=lambda r: r['est_cost'], reverse=True)

total_est = sum(r['est_cost'] for r in rows)
elapsed_hours = max((now - datetime.datetime.combine(today, datetime.time(0, 0), tzinfo=tz)).total_seconds() / 3600.0, 1/60)
burn_rate_day = total_est / elapsed_hours * 24.0

alert_reasons = []
if burn_rate_day > high_burn:
    alert_reasons.append(f"burn_rate_gt_${high_burn:.0f}")
if remaining_val is not None and remaining_val < low_bal:
    alert_reasons.append(f"remaining_lt_${low_bal:.0f}")

print(f"date={today.isoformat()} tz={tz_name}")
print(f"anthropic_sessions_today={len(rows)}")
print(f"estimated_spend_today_usd={total_est:.4f}")
print(f"estimated_daily_burn_usd={burn_rate_day:.2f}")
if remaining_val is None:
    print("remaining_credits=unknown (set ANTHROPIC_CREDITS_REMAINING or pass --remaining)")
else:
    print(f"remaining_credits={remaining_val:.2f}")

print("top_spend_sessions=")
for r in rows[:8]:
    in_tokens = r['input'] + r['cache_read'] + r['cache_write']
    print(f"  - sid={r['sid']} model={r['model']} est=${r['est_cost']:.4f} in={in_tokens} out={r['output']} total={r['total']}")

if alert_reasons:
    print(f"ALERT=true reasons={','.join(alert_reasons)}")
    sys.exit(2)

print("ALERT=false")
PY