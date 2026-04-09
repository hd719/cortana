# PRD: Full Watchlist Artifacts for Trading Alerts

**Status:** Done

## Summary

Keep Telegram trading alerts compact, but persist the full `BUY` / `WATCH` / `NO_BUY` candidate sets as durable run artifacts so the operator can inspect the complete watchlist after each run and retain useful historical context over time.

This solves the current operator gap:

- Telegram intentionally shows only the top names for long watchlists
- the alert can honestly say `top 5 of 17`
- but the full 17-name watchlist is not surfaced in a dedicated, easy-to-find artifact

The goal is to preserve compact alert quality while making the complete trading context available on disk per run.

## Problem

The current trading alert surface is optimized for brevity.

That is good for Telegram, but it creates a workflow gap:

- the operator sees that there are `17` watch names
- the alert only shows the top `5`
- the remaining names are real, but not immediately visible in a purpose-built artifact

This creates friction in two ways:

1. **Operator visibility**
   - Hamel cannot quickly inspect the full watch basket from the run itself
   - the alert is accurate but incomplete by design

2. **Historical learning**
   - there is no dedicated per-run watchlist artifact designed for later review
   - it is harder to answer:
     - which names kept reappearing as `WATCH`
     - which watchlists eventually promoted into `BUY`
     - whether repeated watchlist names became useful later

## Goals

1. Persist the full per-run watchlist and actionable candidate set as a first-class artifact.
2. Keep Telegram compact and operator-friendly.
3. Make full watchlists easy to inspect after any run.
4. Preserve enough history to evaluate recurring names and promotion patterns later.
5. Avoid increasing critical-path compute complexity in the trading cron.

## Non-Goals

1. Do not make Telegram messages list every watch name by default.
2. Do not add a database requirement.
3. Do not move decision authority away from the existing trading pipeline.
4. Do not introduce trading execution behavior.

## Recommendation

### 1. Add a dedicated full-watchlist artifact per run

Each market-session base run should write a new artifact under the existing run directory:

```text
var/backtests/runs/<run_id>/watchlist-full.json
```

Suggested shape:

```json
{
  "schema_version": 1,
  "run_id": "20260319-211220",
  "generated_at": "2026-03-19T21:12:20-04:00",
  "decision": "BUY",
  "regime": {
    "correction": true,
    "label": "correction"
  },
  "summary": {
    "buy": 1,
    "watch": 17,
    "no_buy": 0
  },
  "focus": {
    "ticker": "ARES",
    "action": "BUY",
    "strategy": "Dip Buyer"
  },
  "strategies": {
    "canslim": {
      "buy": [],
      "watch": [],
      "no_buy": []
    },
    "dip_buyer": {
      "buy": [{ "ticker": "ARES", "score": 10, "rank": 1 }],
      "watch": [
        { "ticker": "ALGN", "score": 7, "rank": 1 },
        { "ticker": "ACN", "score": 7, "rank": 2 }
      ],
      "no_buy": []
    }
  }
}
```

### 2. Keep compact Telegram behavior

Telegram should remain concise:

- small watchlists can still be listed inline
- larger watchlists should continue to use `top N of M`

This is the right operator surface.

### 3. Add a simple human-readable companion file

Also write:

```text
var/backtests/runs/<run_id>/watchlist-full.txt
```

This gives a fast operator-readable version without needing to inspect JSON.

### 4. Treat run artifacts as the history source

The run directories already provide a natural event log.

That means we can retain history without polluting git:

- each run keeps its own `watchlist-full.json`
- later tooling can scan run directories and answer:
  - repeated watch names over the last 7/30 days
  - watch-to-buy promotion frequency
  - recurring but never-promoted names

## Why Not Commit Runtime Watchlists to Git

I do **not** recommend committing raw runtime watchlist artifacts into git.

Reasons:

1. **Repo hygiene**
   - frequent generated artifacts create noisy diffs and unnecessary churn

2. **Operational mismatch**
   - these files are runtime outputs, not source code or durable hand-authored docs

3. **Scaling**
   - if this runs daily or intraday, git history becomes bloated with machine-generated snapshots

4. **Better alternative already exists**
   - `var/backtests/runs/<run_id>/` is the correct home for run-scoped evidence

If you later want a version-controlled historical summary, the better approach is:

- keep raw artifacts out of git
- optionally generate a curated weekly or monthly summary document from those artifacts

## Proposed Operator Flow

1. Telegram alert arrives with:
   - focus name
   - summary counts
   - compact top watch names
2. Operator wants the full watchlist.
3. Operator opens:
   - `var/backtests/runs/<run_id>/watchlist-full.txt`
   - or `var/backtests/runs/<run_id>/watchlist-full.json`
4. Historical analysis later reads the run artifacts across time.

## Design Principles

1. **Compact message, full artifact**
   - short Telegram, rich filesystem output

2. **Run-local truth**
   - the full watchlist should be tied to the exact `run_id`

3. **Stable structure**
   - JSON should be consistent enough for future analysis scripts

4. **Fail-open**
   - if the watchlist artifact fails to write, the trading run should still complete
   - but the error should be visible in logs

## Acceptance Criteria

1. Every successful market-session base run writes `watchlist-full.json`.
2. Every successful market-session base run writes `watchlist-full.txt`.
3. The artifact contains the full `BUY/WATCH/NO_BUY` sets as emitted after final guards.
4. Telegram alert remains compact.
5. The run artifact is easy to inspect manually from the filesystem.
6. Historical scripts can use the artifact without reparsing compact Telegram text.

## Nice Follow-Ups

1. Add a small utility that summarizes repeated watch names over the last 7 and 30 days.
2. Add a quick command that prints the latest full watchlist from the newest run.
3. Add a promotion-analysis script:
   - names that appeared as `WATCH`
   - later became `BUY`
   - and their forward outcomes

## Recommendation

This should be built.

It is a clean improvement because it:

- does not bloat Telegram
- does not complicate decision logic
- improves operator trust
- creates better historical evidence for later research

The right storage model is:

- **persist full watchlists in run artifacts**
- **do not commit raw generated watchlists to git**
- optionally commit later **derived summaries**, not the raw runtime files
