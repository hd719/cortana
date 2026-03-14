# Backtest Automation Scaffold

Two-stage flow for long-running trading/backtest jobs, now wired to the real scanner entrypoints in `/Users/hd/Developer/cortana-external/backtester`.

## Shape

- **Cron A / compute** → `tools/trading/run-backtest-compute.sh`
- **Cron B / notify** → `tools/trading/run-backtest-notify.sh`

Compute writes a per-run artifact folder under:

- `var/backtests/runs/<run_id>/`

Each run gets:

- `run.log`
- `stdout.txt`
- `stderr.txt`
- `message.txt`
- `metrics.json`
- `summary.json`

`summary.json` is the atomic contract between compute and notify.
It is written as `summary.tmp.json` and renamed into place only when the run is complete.
`notifiedAt` is stamped only by the notifier after delivery succeeds.

## Real compute presets

If `BACKTEST_COMPUTE_COMMAND` is unset, compute now defaults to `BACKTEST_PRESET='trading-unified'`.

Supported presets:

- `trading-unified`
  - Reuses the existing chunked full-universe pipeline in `tools/trading/trading-pipeline.ts`
  - Real scanners underneath:
    - `/Users/hd/Developer/cortana-external/backtester/.venv/bin/python canslim_alert.py`
    - `/Users/hd/Developer/cortana-external/backtester/.venv/bin/python dipbuyer_alert.py`
  - `stdout.txt` stores the full unified pipeline report
  - `message.txt` stores the compact Telegram payload used by the current market-session alert flow
- `canslim-full-universe`
  - Chunked full-universe CANSLIM scan using the real `canslim_alert.py` entrypoint
- `dipbuyer-full-universe`
  - Chunked full-universe Dip Buyer scan using the real `dipbuyer_alert.py` entrypoint

The chunked presets preserve the current reliability defaults:

- `TRADING_SCAN_CHUNK_SIZE_CANSLIM=20`
- `TRADING_SCAN_CHUNK_PARALLELISM_CANSLIM=2`
- `TRADING_SCAN_CHUNK_SIZE_DIP=20`
- `TRADING_SCAN_CHUNK_PARALLELISM_DIP=2`

Each chunk uses `TRADING_PRIORITY_FILE` so full 120-symbol coverage is preserved without monolithic runs.

## Env knobs

### Compute

- `BACKTEST_PRESET`
  - Optional preset name. Defaults to `trading-unified`.
- `BACKTEST_COMPUTE_COMMAND`
  - Optional escape hatch for a fully custom shell command.
  - If set, it overrides `BACKTEST_PRESET`.
- `BACKTEST_CWD`
  - Optional working directory override.
  - Presets default to `/Users/hd/Developer/cortana-external/backtester`.
- `BACKTEST_STRATEGY`
  - Human-readable label stored in `summary.json`.
- `BACKTEST_TIMEOUT_MS`
  - Applies to custom shell commands.
- `BACKTEST_METRICS_JSON`
  - Optional extra JSON metrics merged into derived metrics in `summary.json`.

### Notify

- `BACKTEST_NOTIFY_TARGET`
  - Optional Telegram target override.
- `BACKTEST_NOTIFY_BIN`
  - Optional delivery command override.
  - Defaults to `tools/notifications/telegram-delivery-guard.sh`.
  - Useful for dry runs, for example `BACKTEST_NOTIFY_BIN=/bin/echo`.

## Example compute / notify split

### Unified market-session compute

```bash
BACKTEST_PRESET='trading-unified' \
BACKTEST_STRATEGY='Trading market-session unified' \
bash /Users/hd/Developer/cortana/tools/trading/run-backtest-compute.sh
```

### Single-strategy compute

```bash
BACKTEST_PRESET='canslim-full-universe' \
BACKTEST_STRATEGY='CANSLIM full-universe' \
bash /Users/hd/Developer/cortana/tools/trading/run-backtest-compute.sh
```

### Notify

```bash
bash /Users/hd/Developer/cortana/tools/trading/run-backtest-notify.sh
```

## Cron payload notes

I did not flip `config/cron/jobs.json` to the two-stage path in this change, because the current market-session cron already delivers cleanly through `run-trading-cron-alert.sh` and an in-place cutover would risk duplicate or changed delivery behavior.

If you want to migrate that flow to Cron A / Cron B later, use these exact payloads:

### Cron A

```bash
BACKTEST_PRESET='trading-unified' \
BACKTEST_STRATEGY='Trading market-session unified' \
bash /Users/hd/Developer/cortana/tools/trading/run-backtest-compute.sh
```

### Cron B

```bash
bash /Users/hd/Developer/cortana/tools/trading/run-backtest-notify.sh
```

Recommended sequencing:

1. Disable the existing `run-trading-cron-alert.sh` payload for that schedule.
2. Enable Cron A on the market-session schedule.
3. Enable Cron B on a short trailing cadence, for example every 2 to 5 minutes.
4. Confirm `summary.json` is written and `notifiedAt` stamps exactly once per run.
