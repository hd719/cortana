#!/usr/bin/env bash
set -euo pipefail

# check-earnings.sh
# Outputs JSON array: [{symbol, earnings_date, days_until, confirmed}]
#
# Data source priority:
# 1) Finnhub (FINNHUB_API_KEY required)
# 2) FMP (FMP_API_KEY optional fallback)
# 3) Yahoo Finance quoteSummary/calendarEvents (no key fallback)
#
# Cache TTL: 12 hours

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_DIR="$SCRIPT_DIR/cache"
CACHE_FILE="$CACHE_DIR/earnings-cache.json"
CONFIG_FILE="$SCRIPT_DIR/.env"
TTL_SECONDS=$((12 * 60 * 60))

mkdir -p "$CACHE_DIR"

if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

FINNHUB_API_KEY="${FINNHUB_API_KEY:-}"
FMP_API_KEY="${FMP_API_KEY:-}"
ALPACA_BASE="${ALPACA_BASE:-http://localhost:3033}"

fetch_symbols() {
  curl -fsS http://localhost:3033/alpaca/portfolio \
    | jq -r '.positions[]?.symbol' \
    | sed '/^null$/d' \
    | awk 'NF' \
    | sort -u
}

normalize_for_api() {
  local s="$1"
  case "$s" in
    BRK-B) echo "BRK.B" ;;
    *) echo "$s" ;;
  esac
}

# Returns compact JSON object: {earnings_date, confirmed}
lookup_finnhub() {
  local symbol="$1"
  local api_symbol="$2"

  [[ -z "$FINNHUB_API_KEY" ]] && return 1

  local from to url
  from="$(date +%F)"
  to="$(date -v+365d +%F 2>/dev/null || python3 - <<'PY'
import datetime as dt
print((dt.date.today()+dt.timedelta(days=365)).isoformat())
PY
)"

  url="https://finnhub.io/api/v1/calendar/earnings?symbol=${api_symbol}&from=${from}&to=${to}&token=${FINNHUB_API_KEY}"

  curl -fsS "$url" | jq -c '
    .earningsCalendar // []
    | map(select(.date != null and .date != ""))
    | sort_by(.date)
    | .[0] // {}
    | {
        earnings_date: (.date // null),
        confirmed: ((.hour // "") | ascii_downcase | test("^(bmo|amc|dmh)$"))
      }
  '
}

lookup_fmp() {
  local symbol="$1"
  local api_symbol="$2"

  [[ -z "$FMP_API_KEY" ]] && return 1

  local url
  url="https://financialmodelingprep.com/api/v3/earning_calendar?symbol=${api_symbol}&apikey=${FMP_API_KEY}"

  curl -fsS "$url" | jq -c '
    if type=="array" then . else [] end
    | map(select(.date != null and .date != ""))
    | sort_by(.date)
    | .[0] // {}
    | {
        earnings_date: (.date // null),
        confirmed: ((.time // "") != "")
      }
  '
}

lookup_yahoo() {
  local symbol="$1"
  local api_symbol="$2"
  local y_symbol="$api_symbol"

  local url
  url="https://query2.finance.yahoo.com/v10/finance/quoteSummary/${y_symbol}?modules=calendarEvents"

  curl -fsS "$url" | jq -c '
    .quoteSummary.result[0].calendarEvents.earnings.earningsDate // []
    | map(.fmt // empty)
    | map(select(. != ""))
    | .[0] as $d
    | {
        earnings_date: (if $d then ($d | strptime("%Y-%m-%d") | strftime("%Y-%m-%d")) else null end),
        confirmed: false
      }
  ' 2>/dev/null || echo '{"earnings_date":null,"confirmed":false}'
}

compute_days_until() {
  local d="$1"
  python3 - "$d" <<'PY'
import datetime as dt, sys
s=sys.argv[1]
if not s or s == 'null':
    print('null')
    raise SystemExit
try:
    target=dt.datetime.strptime(s,'%Y-%m-%d').date()
except Exception:
    print('null')
    raise SystemExit
print((target-dt.date.today()).days)
PY
}

fetch_from_local_endpoint() {
  local symbols_csv="$1"
  curl -fsS "${ALPACA_BASE}/alpaca/earnings?symbols=${symbols_csv}" \
    | jq -c '[.results[]? | {symbol, earnings_date: (.earnings_date // null), days_until: (.days_until // null), confirmed: (.confirmed // false)}]'
}

is_cache_fresh_for_symbols() {
  local symbols_json="$1"
  [[ -f "$CACHE_FILE" ]] || return 1

  python3 - "$CACHE_FILE" "$TTL_SECONDS" "$symbols_json" <<'PY'
import json, sys, time
p=sys.argv[1]
ttl=int(sys.argv[2])
symbols=set(json.loads(sys.argv[3]))
try:
    d=json.load(open(p))
except Exception:
    raise SystemExit(1)
if time.time() - d.get('generated_at_epoch',0) > ttl:
    raise SystemExit(1)
cached=set(d.get('symbols',[]))
if cached != symbols:
    raise SystemExit(1)
print(json.dumps(d.get('results',[]), separators=(',',':')))
PY
}

main() {
  local symbols=()
  while IFS= read -r line; do
    [[ -n "$line" ]] && symbols+=("$line")
  done < <(fetch_symbols)

  if [[ ${#symbols[@]} -eq 0 ]]; then
    echo '[]'
    exit 0
  fi

  local symbols_json
  symbols_json="$(printf '%s\n' "${symbols[@]}" | jq -R . | jq -s .)"

  if cached="$(is_cache_fresh_for_symbols "$symbols_json" 2>/dev/null)"; then
    echo "$cached"
    exit 0
  fi

  local out='[]'
  local s api_symbol res date confirmed days

  local symbols_csv
  symbols_csv="$(printf '%s\n' "${symbols[@]}" | paste -sd, -)"

  if out_local="$(fetch_from_local_endpoint "$symbols_csv" 2>/dev/null)"; then
    out="$out_local"
  fi

  for s in "${symbols[@]}"; do
    # Skip symbols already resolved by Alpaca endpoint.
    if jq -e --arg s "$s" '.[] | select(.symbol == $s and .earnings_date != null)' <<<"$out" >/dev/null 2>&1; then
      continue
    fi

    api_symbol="$(normalize_for_api "$s")"

    if res="$(lookup_finnhub "$s" "$api_symbol" 2>/dev/null)"; then
      :
    elif res="$(lookup_fmp "$s" "$api_symbol" 2>/dev/null)"; then
      :
    else
      res="$(lookup_yahoo "$s" "$api_symbol" 2>/dev/null || echo '{"earnings_date":null,"confirmed":false}')"
    fi

    date="$(jq -r '.earnings_date // "null"' <<<"$res")"
    confirmed="$(jq -r '.confirmed // false' <<<"$res")"
    if [[ "$date" == "null" || -z "$date" ]]; then
      days="null"
      date="null"
    else
      days="$(compute_days_until "$date")"
    fi

    # replace existing symbol row or append
    out="$(jq -c --arg symbol "$s" --arg date "$date" --argjson days "$days" --argjson confirmed "$confirmed" '
      (map(select(.symbol != $symbol))) + [{symbol:$symbol, earnings_date:(if $date=="null" then null else $date end), days_until:$days, confirmed:$confirmed}]
    ' <<<"$out")"
  done

  jq -c . <<<"$out" > "$CACHE_FILE.tmp"
  mv "$CACHE_FILE.tmp" "$CACHE_FILE"

  python3 - "$CACHE_FILE" "$symbols_json" <<'PY'
import json,sys,time
p=sys.argv[1]
symbols=json.loads(sys.argv[2])
results=json.load(open(p))
payload={
  'generated_at_epoch': int(time.time()),
  'generated_at_iso': __import__('datetime').datetime.utcnow().isoformat()+'Z',
  'symbols': symbols,
  'results': results,
}
json.dump(payload, open(p,'w'), separators=(',',':'))
PY

  jq -c '.results' "$CACHE_FILE"
}

main "$@"
