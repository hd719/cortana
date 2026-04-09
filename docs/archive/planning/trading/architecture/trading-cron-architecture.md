# Trading Cron Architecture

## Overview

The trading alert pipeline now uses a **precompute + market-intel + compute + notify + re-check** routine:

1. Pre-market precompute refreshes feature-snapshot and calibration artifacts.
2. Polymarket market-intel refresh rebuilds the external macro/context artifacts consumed by the Python bridge.
3. Market-session compute runs the unified CANSLIM + Dip Buyer scan and writes the official base artifact.
4. Notify delivers only finalized base runs.
5. Midday re-checks revisit the current `BUY/WATCH` basket without rerunning the full scan.

This keeps research and calibration inputs fresh while preserving the production rule that only the base compute run decides trading-run success or failure.

## Cron 0 — Precompute (`🧪 Trading Precompute Refresh`)

- **Job ID:** `trading-precompute-20260319`
- **Agent:** `cron-market`
- **Schedule:** `10 8 * * 1-5` ET (8:10 AM on weekdays)
- **Timeout:** 600s
- **What it does:**
  1. Runs `tools/trading/run-trading-precompute.sh`
  2. Refreshes the nightly discovery feature snapshot via `nightly_discovery.py --limit 20 --json`
  3. Settles experimental-alpha outcomes via `experimental_alpha.py --settle --json`
  4. Refreshes the buy-decision calibration artifact via `buy_decision_calibration.py --json`
- **Does NOT** send Telegram messages or alter live trading-run status
- **Healthy state:** returns `trading-precompute complete`

### Why this lane exists

- Live market-session scans stay deterministic and do not have to rebuild research artifacts inline.
- The unified report can surface calibration freshness from the latest artifact without changing decision authority.
- Experimental-alpha settlement and buy-decision calibration become part of the routine instead of manual operator steps.

## Cron P — Polymarket Context (`🧠 Polymarket Market Intel Refresh`)

- **Job ID:** `polymarket-market-intel-20260319`
- **Agent:** `cron-market`
- **Schedule:** `30 8 * * 1-5` ET (8:30 AM on weekdays)
- **Timeout:** 300s
- **What it does:**
  1. Runs `/Users/hd/Developer/cortana-external/tools/market-intel/run_market_intel.sh`
  2. Refreshes the Python SPY regime snapshot first via the wrapper
  3. Rebuilds Polymarket latest/history/watchlist artifacts under `/Users/hd/Developer/cortana-external/var/market-intel/polymarket`
  4. Verifies the Python bridge can consume the resulting compact/report/watchlist outputs
- **Does NOT** send Telegram messages directly
- **Healthy state:** returns `market-intel refresh complete`

## Cron A — Compute (`📈 CANSLIM Alert Scan`)

- **Job ID:** `9d2f7f92-b9e9-48bc-87b0-a5859bb83927`
- **Agent:** `cron-market`
- **Schedule:** `30 9,12,15 * * 1-5` ET (9:30 AM, 12:30 PM, 3:30 PM on weekdays)
- **Stagger:** 240s (4 min randomized delay to avoid thundering herd)
- **Timeout:** 660s (11 min)
- **What it does:**
  1. Runs the unified CANSLIM + Dip Buyer pipeline via `tools/trading/run-backtest-compute.sh`
  2. Scans 240 symbols total (120 CANSLIM + 120 Dip Buyer, ranked by universe selection)
  3. Reads the latest buy-decision calibration artifact when present and annotates freshness in the report
  3. Writes artifacts atomically to `var/backtests/runs/<runId>/`:
     - `summary.json` — structured run result with metrics, status, timestamps
     - `message.txt` — pre-formatted Telegram alert payload
     - `watchlist-full.json` — full post-guard BUY/WATCH/NO_BUY sets for the run
     - `watchlist-full.txt` — operator-readable full watchlist companion
     - `stdout.txt`, `stderr.txt`, `run.log`, `metrics.json`
  4. Sets `notifiedAt: null` in `summary.json` so Cron B can pick it up
- **Does NOT** send Telegram messages directly
- **Typical runtime:** 380–510s depending on market data latency

### Why 660s timeout

Observed compute durations (March 2026):
| Run | Duration |
|-----|----------|
| 2026-03-16 19:30 | 416s |
| 2026-03-16 22:21 | 381s |
| 2026-03-17 09:30 | 509s |

Previous timeout of 360s caused consistent false-positive timeout errors. The 660s ceiling provides ~30% headroom over the worst observed case.

## Cron B — Notify (`📣 Trading Backtest Notify`)

- **Job ID:** `35e3be71-260a-4b2f-9e9e-892e20aa70cb`
- **Agent:** `main`
- **Schedule:** `*/5 9-16 * * 1-5` ET (every 5 min during market hours)
- **Timeout:** 90s
- **What it does:**
  1. Runs `tools/trading/run-backtest-notify.sh`
  2. Finds the latest `summary.json` with `notifiedAt == null`
  3. Sends the content of `message.txt` to Telegram via Monitor's owner lane
  4. Stamps `notifiedAt` in `summary.json` so the run is not re-sent
- **Typical runtime:** <5s

## Cron C — Re-check (`🔁 Trading Quick Re-check`)

- **Job ID:** `trading-quick-recheck-20260319`
- **Agent:** `cron-market`
- **Schedule:** `0 11,15 * * 1-5` ET (11:00 AM and 3:00 PM on weekdays)
- **Timeout:** 180s
- **What it does:**
  1. Reads the latest successful market-session base run only
  2. Extracts the current `BUY` and `WATCH` names from the persisted `stdout.txt` pipeline report
  3. Applies optional operator exclusions before quick-checking the basket
  4. Runs bounded `quick-check` analysis on that basket only
  5. Compares current verdicts to persisted local state under `var/backtests/rechecks/state.json`
  6. Alerts only on material verdict changes, with cooldown / dedupe to avoid spam
- **Does NOT** rerun the full 120-name CANSLIM + Dip Buyer scan
- **Healthy state:** returns `NO_REPLY`

### Re-check State File (keep this)

`var/backtests/rechecks/state.json` is intentional durable operational memory for Cron C.

It stores per-symbol re-check memory (`verdict`, `lastSeenAt`, `lastAlertedAt`, `lastAlertSignature`) so the lane can:
- detect true verdict transitions,
- apply cooldown/dedupe,
- avoid repeat alert spam for unchanged conditions.

This file is generated/updated by `tools/trading/trading-recheck.ts` and should be retained across runs.

### Re-check Exclusion Controls

Use these controls to remove symbols from the re-check lane even if they appear in the latest base run's `BUY/WATCH` output:

| Variable | Default | Purpose |
|----------|---------|---------|
| `TRADING_RECHECK_EXCLUDE_SYMBOLS` | empty | Comma/whitespace-separated symbol list to exclude from the re-check basket |
| `TRADING_RECHECK_EXCLUDE_FILE` | unset | Path to a newline/comma-separated symbol file (`#` comments allowed) to exclude from the re-check basket |

If exclusions remove all candidates, Cron C returns `NO_REPLY` and sends no alert.

## Artifact Boundary

The key design principle: **Precompute prepares side artifacts, Cron P refreshes external Polymarket context, Cron A writes the official base run, Cron B reads only finalized base-run files.** They share no in-memory runtime state — only filesystem artifacts. This means:

- Precompute can fail without turning a market-session run into a false failure
- Cron P can fail without blocking the base trading pipeline; stale Polymarket context should be suppressed by the Python bridge
- Cron A can be retried or run manually without triggering duplicate notifications
- Cron B can be retried without re-running expensive compute
- A failed Cron A still leaves partial artifacts for debugging
- Cron B only sends runs that completed successfully (`status: "success"`) and haven't been notified
- Cron C only re-checks fresh successful base artifacts and stays quiet on stale/missing inputs

## Pipeline Details

The compute step uses a **chunked full-universe scan** (per Hamel's preference to keep the full 120-symbol universe per strategy rather than shrinking it). Universe ranking (PR cortana-external#114) ensures the top 120 candidates are selected by quality before scanning.

### Key env vars

| Variable | Default | Purpose |
|----------|---------|---------|
| `BACKTEST_PRESET` | `trading-unified` | Which pipeline preset to run |
| `TRADING_SCAN_LIMIT` | `120` | Max symbols per strategy |
| `TRADING_SCAN_CHUNK_SIZE` | `0` (no chunking) | Symbols per chunk (0 = single pass) |
| `TRADING_SCAN_LIMIT_CANSLIM` | falls back to `TRADING_SCAN_LIMIT` | CANSLIM-specific override |
| `TRADING_SCAN_LIMIT_DIP` | falls back to `TRADING_SCAN_LIMIT` | Dip Buyer-specific override |

## Monitoring

- **Owner lane:** Monitor (via `accountId: "monitor"`)
- **SLO check:** `cron-slo-monitor` flags runs that exceed 80% of timeout budget or have consecutive errors ≥2
- **Healthy state:** cron-slo-monitor returns `NO_REPLY`

## Run Order

Weekday routine:

1. `8:10 AM ET` — Cron 0 refreshes discovery, settlement, and calibration artifacts
2. `8:30 AM ET` — Cron P refreshes Polymarket market-intel artifacts and verifies the bridge
3. `9:30 AM / 12:30 PM / 3:30 PM ET` — Cron A writes official market-session base runs
4. `Every 5 min during market hours` — Cron B notifies exactly one finalized base run at a time
5. `11:00 AM / 3:00 PM ET` — Cron C re-checks only the latest live `BUY/WATCH` basket

If Cron 0 fails, live trading still runs. The consequence is stale or missing calibration annotation, not a blocked market-session alert.
If Cron P fails, live trading still runs. The consequence is stale or missing Polymarket context, which the Python bridge should ignore as unavailable.

## Change Log

| Date | Change | Reason |
|------|--------|--------|
| 2026-03-17 | Timeout 360s → 660s | Compute consistently exceeded 360s ceiling (381–509s observed) causing false timeout errors |
