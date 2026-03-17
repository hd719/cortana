# Trading Cron Architecture

## Overview

The trading alert pipeline uses a **two-cron split architecture** to separate long-running compute from lightweight notification delivery. This avoids holding a single cron session open for the entire backtest duration and makes each phase independently retriable.

## Cron A — Compute (`📈 CANSLIM Alert Scan`)

- **Job ID:** `9d2f7f92-b9e9-48bc-87b0-a5859bb83927`
- **Agent:** `cron-market`
- **Schedule:** `30 9,12,15 * * 1-5` ET (9:30 AM, 12:30 PM, 3:30 PM on weekdays)
- **Stagger:** 240s (4 min randomized delay to avoid thundering herd)
- **Timeout:** 660s (11 min)
- **What it does:**
  1. Runs the unified CANSLIM + Dip Buyer pipeline via `tools/trading/run-backtest-compute.sh`
  2. Scans 240 symbols total (120 CANSLIM + 120 Dip Buyer, ranked by universe selection)
  3. Writes artifacts atomically to `var/backtests/runs/<runId>/`:
     - `summary.json` — structured run result with metrics, status, timestamps
     - `message.txt` — pre-formatted Telegram alert payload
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

## Artifact Boundary

The key design principle: **Cron A writes files, Cron B reads files.** They share no runtime state — only the filesystem under `var/backtests/runs/`. This means:

- Cron A can be retried or run manually without triggering duplicate notifications
- Cron B can be retried without re-running expensive compute
- A failed Cron A still leaves partial artifacts for debugging
- Cron B only sends runs that completed successfully (`status: "success"`) and haven't been notified

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

## Change Log

| Date | Change | Reason |
|------|--------|--------|
| 2026-03-17 | Timeout 360s → 660s | Compute consistently exceeded 360s ceiling (381–509s observed) causing false timeout errors |
