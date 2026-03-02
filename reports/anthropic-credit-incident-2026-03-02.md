# Anthropic Credit Incident Report — 2026-03-02

## Executive summary
- **Incident:** Anthropic credits hit $0 around ~12:05 PM ET, causing dashboard/model failures.
- **Immediate recovery:** +$100 credit top-up restored service.
- **Primary failure mode:** Anthropic auth/rate-limit failover storm with repeated retries.
- **Likely root cause:** Unbounded retry pressure plus expensive default model posture (Opus) and insufficient real-time budget guardrails.

## Evidence collected

### 1) Session token audit (today)
Source: `~/.openclaw/agents/main/sessions/sessions.json` (same backing source used by status session summaries).

Method:
- Filter entries updated today (ET).
- Keep Anthropic sessions only (`claude*` models).
- Dedupe aliases by `sessionId` (keep highest token record per session).
- Estimate cost with requested **Opus pricing**: input/cache $15/M, output $75/M.

Results:
- Anthropic sessions today (deduped): **5**
- Estimated spend from persisted session snapshots: **$3.1423**
- Estimated projected daily burn from snapshot pace: **$6.17/day**

Top estimated spend sessions:
1. `7b7478a6-dd7e-4e08-87df-4feb11fa84ce` (claude-sonnet-4-20250514) — **$1.7386**
2. `19f662b1-fecd-4159-b55c-7edd89809c5b` (claude-opus-4-6) — **$0.5917**
3. `5b29e8ee-3299-41e9-a518-48d0975baf1a` (claude-opus-4-6) — **$0.2833**
4. `b04842bd-ba85-48cb-beda-77a15cd29e85` (claude-opus-4-6) — **$0.2652**
5. `98f6c5f5-9c1e-403a-9b88-5fdb9d2b2abd` (claude-opus-4-6) — **$0.2635**

⚠️ Note: session snapshots significantly under-report true incident burn because failed/retried upstream attempts and pre-failure retries are not fully represented in current session token snapshots.

### 2) Retry/failover storm indicators
Source: `~/.openclaw/logs/gateway.err.log` (today)

- `lane task error` count: **104**
  - **62** × `API rate limit reached`
  - **30** × `AI service temporarily overloaded`
  - **12** × `No available auth profile for anthropic (all in cooldown or unavailable)`
- `embedded run agent end` failures: **191**
  - **126** rate-limit failures
  - **64** overload failures
  - **1** context overflow

Interpretation:
- System entered repeated Anthropic retry/error loops after credit/rate pressure.
- Error storms consumed compute cycles and likely triggered additional paid attempts before hard failure.

## Remediation implemented

### A) Budget monitor script
Created: `tools/budget/anthropic-monitor.sh`

Capabilities:
- Parses today’s Anthropic session token counts from session store.
- Estimates spend using Opus pricing ($15/M input+cache, $75/M output).
- Calculates projected **daily burn rate**.
- Flags alert conditions:
  - remaining credits `< $20` (when provided via env/flag)
  - burn rate `> $25/day`
- Prints top spend sessions for fast triage.

Usage examples:
- `tools/budget/anthropic-monitor.sh`
- `ANTHROPIC_CREDITS_REMAINING=18 tools/budget/anthropic-monitor.sh`
- `tools/budget/anthropic-monitor.sh --remaining 18`

### B) Heartbeat integration (repo)
Updated `HEARTBEAT.md`:
- API budget check now every 4h during business hours.
- Explicit thresholds:
  - low credit alert `< $20`
  - burn alert `> $25/day`
- Added spending controls section (context/sub-agent timeout/polling limits).

Added cron job definition to `config/cron/jobs.json`:
- **Name:** 💸 Anthropic Budget Guard (business hours)
- **Schedule:** `0 9,13,17 * * 1-5` ET
- Runs budget script and alerts only on threshold breach.

## Spending controls (enforcement plan)
1. **Context limits for heavy sessions**
   - Trigger at >120k tokens/session for compaction/reset.
   - Prefer Sonnet/Codex fallback for routine automation; reserve Opus for high-complexity work.

2. **Sub-agent timeout policy**
   - Require explicit `timeoutSeconds` on heavy cron/agent tasks.
   - Default 90s, hard cap 300s unless justified.

3. **Dashboard polling limits**
   - Minimum 30s poll cadence per client for expensive status/model checks.
   - No retry loops without exponential backoff + max-attempt cap.

4. **Retry control on provider failures**
   - Add per-window retry budget/circuit breaker to stop storms when Anthropic is exhausted/cooldown.

## Open items
- Anthropic remaining credit cannot currently be pulled from `openclaw status --usage` due scope error (`user:profile` scope missing); direct balance feed should be added (API or secure manual input pipeline).
- Runtime cron source-of-truth is `~/.openclaw/cron/jobs.json`; sync/apply flow should update runtime and then backup to repo.
