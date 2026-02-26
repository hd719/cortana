#!/usr/bin/env bash
set -u

SCRIPT="/Users/hd/Developer/cortana-external/backtester/canslim_alert.py"
PYTHON_BIN="/Users/hd/Developer/cortana-external/backtester/venv/bin/python"
CACHE_DIR="/Users/hd/clawd/tools/trade-alerts/cache"
OUT_FILE="$CACHE_DIR/canslim-latest.txt"
META_FILE="$CACHE_DIR/canslim-latest.meta.json"

mkdir -p "$CACHE_DIR"

start_epoch=$(date +%s)
timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

output="$($PYTHON_BIN -W ignore "$SCRIPT" --limit 8 --min-score 6 2>/dev/null)"
exit_code=$?

duration=$(( $(date +%s) - start_epoch ))

if [ $exit_code -eq 0 ]; then
  printf "%s\n" "$output" > "$OUT_FILE"
else
  {
    echo "ERROR: CANSLIM precompute failed"
    echo "$output"
  } > "$OUT_FILE"
fi

cat > "$META_FILE" <<EOF
{"timestamp":"$timestamp","exit_code":$exit_code,"duration_seconds":$duration}
EOF

exit 0
