# Cron Reliability Fixes — 2026-03-18

## 1. Daily Auto-Update: Minimize Gateway Downtime

**Problem:** The `🔄 Daily Auto-Update` cron at 4:22 AM was causing ~56 minutes of gateway downtime. The old flow ran `pnpm add -g openclaw@latest` which triggered an automatic SIGTERM → shutdown, and the gateway only came back after the entire brew+pnpm+skills update pipeline finished.

**Fix:** Updated the cron prompt to:
- Do all package downloads/installs FIRST (brew, pnpm, skills)
- Only restart the gateway IF the OpenClaw version actually changed
- Use explicit `openclaw gateway restart` with a 15s verify check
- If restart fails, immediately attempt `openclaw gateway start`
- Never let gateway stay down >30 seconds

**Expected impact:** Gateway downtime drops from ~56 min to <30 seconds (only when an actual OpenClaw version bump occurs). Most nights = zero downtime.

## 2. CANSLIM Alert Scan: Timeout Fix

**Problem:** 3 consecutive timeouts at the 660s (11 min) limit.

**Fix:**
- Bumped cron `timeoutSeconds` from 660 → 900 (15 min)
- Added `timeout 840` shell wrapper around the compute script so it gets killed cleanly before the cron timeout fires
- Added guidance about stuck ticker data fetches

## 3. Weekly Fitness Insights: Deterministic Write Path

**Problem:** Write failure using `~/` tilde path instead of absolute `/Users/hd/` path in sandboxed workspace.

**Fix:** Tightened the cron prompt to:
- compute `YEAR_WEEK` explicitly via shell
- build `OUT_FILE` as a fully expanded absolute `/Users/hd/...` path
- `mkdir -p` the weekly directory before writing
- forbid `~/...`, relative paths, and the literal `YYYY-WXX` placeholder
- verify the exact file with `test -f` and `ls -l` after writing

**Expected impact:** The weekly insights job should stop failing on path resolution and produce a deterministic markdown artifact every Sunday run.
