# Investigation: Stale Telegram Typing Indicator on Sub-Agent Bursts

Date: 2026-02-25

## TL;DR
This is not just a UI race. It is primarily an **announce delivery targeting bug** that causes repeated failed sub-agent announce attempts, which in turn repeatedly spins agent runs that can keep Telegram `typing` alive (or repeatedly re-trigger it) until TTL cleanup.

Core trigger seen in logs:
- `Error: Delivering to Telegram requires target <chatId>`

That failure is retried in the sub-agent announce path and can recur across restarts because the underlying session/delivery metadata remains invalid in persisted state.

---

## 1) Gateway log findings

Searched `~/.openclaw/logs/gateway.log` for typing + Telegram + announce errors.

### High-signal patterns

1. Repeated announce failures (same run family) with missing Telegram target:
- `[ws] ⇄ res ✗ agent ... Error: Delivering to Telegram requires target <chatId> ... runId=announce:v1:agent:main:subagent:...`
- Followed by 2 more immediate cached failures for same logical announce attempt.

2. Timing pattern on retries around ~17s spacing in gateway output (practically matching backoff + call overhead).

3. Typing fallback stopper appears in logs:
- `typing TTL reached (2m); stopping typing indicator`

This means typing loops are not always stopping promptly through normal idle/cleanup path and rely on TTL failsafe.

---

## 2) Source code findings (OpenClaw install)

Inspected:
- `/opt/homebrew/lib/node_modules/openclaw/dist/reply-Cx57rl6c.js`

### A) Typing lifecycle

- `createTypingController(...)` (around line ~74081)
  - starts keepalive loop
  - uses TTL (`typingTtlMs`, default 2m)
  - logs `typing TTL reached (2m); stopping typing indicator`

- `createTypingKeepaliveLoop(...)` (around ~20095)
  - simple interval loop

- Telegram typing callback wiring (around ~43043 / ~44006)
  - `sendChatAction(chatId, "typing")`
  - Telegram path passes `start` typing callback, no explicit `stop` API (Telegram naturally expires typing unless renewed)

### B) Sub-agent announce delivery + retries

- `runAnnounceDeliveryWithRetry(...)` (~11831)
- Retry delays constant:
  - `DIRECT_ANNOUNCE_TRANSIENT_RETRY_DELAYS_MS = [5000, 10000, 20000]` (non-test mode)

So one failing announce can produce multiple re-attempts, each potentially creating additional agent/delivery activity.

### C) Announce direct-send decision path

- `sendSubagentAnnounceDirectly(...)` (~12152)
- External delivery decision (`shouldDeliverExternally`) can still route through agent call path where target resolution is invalid, leading to:
  - `Delivering to Telegram requires target <chatId>`

The error appears treated as transient enough to re-attempt in this flow, causing noisy replays and repeated side effects.

---

## 3) Persisted-state clue (why restart doesn’t fix)

Checked session store:
- `~/.openclaw/agents/main/sessions/sessions.json`

Observed many Telegram sessions (especially cron-like keys) with channel context but **missing `to` target** in origin context. Example classes:
- `agent:main:cron:...` entries with telegram channel but no usable `to/chatId`.

This explains restart recurrence:
- restart clears process memory,
- but invalid persisted delivery context remains,
- next sub-agent completion re-enters same broken announce path.

---

## 4) Related upstream GitHub issues (openclaw/openclaw)

Relevant open issues found with `gh issue list/view`:

- #26838 — Telegram typing indicator persists on 2026.2.24
- #18150 — Sub-agent completion replay loop into parent session
- #19443 — `sessions_spawn` explicit delivery target for sub-agent announcements (missing target problem)
- #26867 — Subagent announce delivery broken across surfaces on 2026.2.23+

These align strongly with observed local behavior.

---

## 5) Probable root cause chain

1. Multiple sub-agents complete close together.
2. Completion announce path tries direct announce into requester context.
3. For some requester/session contexts, Telegram target is missing (`chatId/to` unresolved).
4. Announce call fails with `Delivering to Telegram requires target <chatId>`.
5. Retry/backoff triggers additional attempts (5s/10s/20s), producing repeated run activity.
6. Typing indicators can appear to “stick” because fresh attempts keep re-triggering typing before prior indicator naturally expires; some runs only stop via 2m TTL fallback.

So the typing symptom is downstream of announce routing/target resolution failures + retry policy.

---

## 6) Recommended fixes

### Code-level fixes (best)

1. **Treat missing-target errors as permanent** for announce delivery retries.
   - Add pattern like `requires target <chatId>` to permanent error classifiers in announce retry logic.
   - Prevent pointless 5/10/20s retries.

2. **Guard external announce eligibility on valid target.**
   - In announce direct path, if channel is Telegram and no `to/chatId`, do not attempt direct external send.
   - Fall back to queue/internal route safely.

3. **Persist and inherit delivery origin robustly for spawned sessions.**
   - Ensure `sessions_spawn`/subagent completion always retains valid parent delivery context (`channel`, `to`, `threadId`, `accountId`).

4. **Add startup/session-store sanitizer** for stale Telegram session entries with missing `to`.
   - Mark non-deliverable or repair from latest known valid origin for same session family.

5. **Typing hard-stop on failed delivery path.**
   - Force cleanup when delivery pipeline errors before response dispatch fully settles.

### Operational workarounds (immediate)

1. Reduce typing visibility while bug exists:
   - Set `agents.defaults.typingMode = "never"`.

2. Avoid sub-agent announce direct-to-Telegram for contexts lacking explicit target:
   - prefer internal queue/steer behavior until target is resolved.

3. Clean stale session entries that have Telegram channel but missing target for requester contexts involved in cron/sub-agent workflows.

---

## 7) Confidence

High confidence that **missing Telegram target in sub-agent announce delivery context** is the primary defect driving repeated retries and typing side-effects.

Evidence basis:
- repeated gateway error signatures,
- retry/backoff logic in source,
- TTL fallback logs,
- persisted session metadata with invalid delivery target,
- matching upstream issues.
