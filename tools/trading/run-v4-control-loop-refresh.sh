#!/usr/bin/env bash
set -euo pipefail

BACKTESTER_DIR="/Users/hd/Developer/cortana-external/backtester"

cd "$BACKTESTER_DIR"

uv run python trade_lifecycle_cycle.py --review-only --json >/dev/null
uv run python control_loop_schedule_check.py --root "$BACKTESTER_DIR" --fail-on-late >/dev/null

echo "control-loop refresh complete"
