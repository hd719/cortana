# Sub-agent completion routing: implementation notes (2026-02-25)

## Goal
Route Covenant sub-agent completions back through the **main Cortana session** (agent turn), instead of sending completion text directly to Telegram via direct outbound `send`.

---

## What I investigated

## 1) Local docs (`/Users/hd/openclaw/docs/`)
- `docs/inter-agent-communication-gaps.md` confirms async completion announce exists and is push-based.
- No doc-level setting found to disable only sub-agent direct completion sends.

## 2) Runtime config (`~/.openclaw/openclaw.json`, `~/.openclaw/agents/main/agent/`)
- `~/.openclaw/openclaw.json` has no subagent completion-delivery toggle.
- Main agent dir currently contains auth/model files only; no custom hook/plugin config there for subagent delivery override.

## 3) OpenClaw source/runtime (`/opt/homebrew/lib/node_modules/openclaw/dist/...`)
Key findings in `reply-Cx57rl6c.js`:
- `sessions_spawn` tool path sets `expectsCompletionMessage: true`.
- Completion announce flow is `runSubagentAnnounceFlow(...)`.
- Delivery path is `deliverSubagentAnnouncement(...)` -> `sendSubagentAnnounceDirectly(...)`.
- In that function, when completion has a deliverable target (`channel` + `to`), OpenClaw can use direct `callGateway({ method: "send" ... })` for completion text, bypassing a parent-session relay turn.

This is the behavior that causes direct Telegram completion announcements.

---

## Built-in config toggle check
I looked for a built-in setting to disable only this direct completion path (without disabling normal typing or global delivery), including:
- `agents.defaults.subagents.*` schema entries
- spawn params (`thread`, `mode`, etc.)
- announce-related settings

Result: **No built-in first-class config toggle found** for “force sub-agent completion through requester session relay only.”

(Only `announceTimeoutMs` and spawn limits/model/timeouts are exposed under `agents.defaults.subagents`.)

---

## Implemented fix
I patched runtime logic to force requester-session relay for subagent completions by disabling the direct completion-send branch.

### Files changed
1. `/opt/homebrew/lib/node_modules/openclaw/dist/reply-Cx57rl6c.js`
2. `/opt/homebrew/lib/node_modules/openclaw/dist/subagent-registry-DAeKcITJ.js`

### Exact change
In `sendSubagentAnnounceDirectly(...)`, changed the completion direct-send guard from:

```js
if (params.expectsCompletionMessage && hasCompletionDirectTarget && params.completionMessage?.trim()) {
```

to:

```js
const routeCompletionViaRequesterSession = true;
if (!routeCompletionViaRequesterSession && params.expectsCompletionMessage && hasCompletionDirectTarget && params.completionMessage?.trim()) {
```

Effect:
- Direct completion `send` path is skipped.
- Completion routing proceeds via requester-session agent announce flow.
- Main Cortana session remains the relay point.

---

## Why this matches the requirement
- Stops sub-agent completion bypass directly to Telegram.
- Keeps main-session behavior intact (Cortana can still type/respond to user).
- Does **not** globally disable typing indicators.
- Only changes sub-agent completion direct-send branch.

---

## Operational notes
- This is a runtime patch under `node_modules` and may be overwritten by OpenClaw updates.
- If overwritten, re-apply this same patch or upstream a proper config flag in OpenClaw core.

### Suggested upstream durable option
Add a config knob such as:

```json
"agents": {
  "defaults": {
    "subagents": {
      "completionDelivery": "requester-session" // vs "direct"
    }
  }
}
```

Then gate the same branch on that setting.

---

## Validation checklist (recommended)
1. Spawn a Covenant sub-agent from main Telegram session.
2. Confirm no immediate raw direct completion message is posted by sub-agent path.
3. Confirm completion appears as a main-session relay (Cortana voice/summary).
4. Confirm normal main-session typing still works.
