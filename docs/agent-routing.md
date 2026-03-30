# Agent Routing Architecture

## Overview

This system runs multiple agents, each with its own workspace, model, and session scope. Understanding routing prevents "who am I talking to?" confusion.

## Agents

| Agent | Purpose | Workspace | Model | Accepts DMs? |
|-------|---------|-----------|-------|-------------|
| **main** (Cortana) | Primary assistant, conversation, coordination | `/Users/hd/Developer/cortana` | opus | Yes (Telegram, webchat) |
| cron-health | Health checks (X session, fitness service, etc.) | `~/.openclaw/workspaces/cron-health` | gpt-5.1 | No — cron only |
| cron-comms | Communication checks | `~/.openclaw/workspaces/cron-comms` | gpt-5.3-codex | No — cron only |
| cron-fitness | Fitness data | `~/.openclaw/workspaces/cron-fitness` | gpt-5.3-codex | No — cron only |
| cron-market | Market analysis | `~/.openclaw/workspaces/cron-market` | gpt-5.3-codex | No — cron only |
| cron-maintenance | System updates | `~/.openclaw/workspaces/cron-maintenance` | gpt-5.1 | No — cron only |
| **huragok** | Standalone Huragok identity (dedicated Telegram-bound lane + spawn target) | `/Users/hd/Developer/cortana` | gpt-5.3-codex | Yes (bound group/channel) |
| **researcher** | Dedicated investigation/research execution lane for Cortana delegation | `/Users/hd/Developer/cortana` | gpt-5.3-codex | No — spawn target only |
| cortana-acp | On-demand specialist coding lane for explicit ACP runtime requests | `/Users/hd/Developer/cortana` | gpt-5.3-codex | No — spawn target only |

## Channel Routing

- **Telegram DMs** → `main` agent (Cortana)
- **Webchat** → `main` agent (Cortana)
- **Telegram group `-5229462108`** → `huragok` (dedicated standalone Huragok Telegram identity)
- **Huragok spawned work** → `huragok` (`agentId: "huragok"`; no separate worker lane)
- **Explicit coding-runtime asks** ("use Codex", "use Claude Code", "use Gemini") → Codex ACP harness target (`agentId: "codex"`)
- **Huragok requesting ACP escalation** → bubble back to `main`/Cortana for dispatch; Huragok is not an ACP dispatcher
- **Cron jobs** → respective cron/specialist agent (deliver results via `message` tool using mapped `accountId`; keep Cortana lane clean)

## Stable Ops Owner Lane

Monitor is the user-facing owner lane for inbox/email ops and operational maintenance alerts.
Monitor is the user-facing owner lane for trading alert scans.
Quiet maintenance watchers should return exactly `NO_REPLY` on healthy paths.

- Another specialist can still execute the underlying work.
- The user-facing delivery account, prompt ownership language, and cron routing should still point to Monitor.
- If this contract changes, update `MEMORY.md`, `HEARTBEAT.md`, `docs/operating-rules.md`, `README.md`, and `config/cron/jobs.json` in the same workflow.

## Cortana Protocol (Routing)

- Cortana is orchestrator/command deck, not default implementer.
- Code implementation and PR creation route to Huragok unless Hamel explicitly asks Cortana to execute directly.
- Inter-agent `sessions_send` is **TASK-only**. No FYI/status chatter over agent lanes.
- TASK lane message contract: objective, owner, constraints, delivery target, done condition — nothing else.
- If a specialist already delivered directly to Hamel, Cortana should not echo duplicate output.
- Cortana lane should contain decisions, synthesis, blockers, and coordination — not routine cron noise.
- Status claims must be check-backed (CI/cron/runtime verification before declaring green).
- If wrong, correct quickly and post the verified state.

## ACP On-Demand Routing Policy

Default behavior stays unchanged: use normal sub-agent orchestration.

Route to Codex ACP (`agentId: "codex"`) only when the user explicitly requests a coding runtime (Codex, Claude Code, Gemini). This keeps ACP available as a specialist lane without hijacking normal dispatch.

Telegram-specific usage notes and known ACP thread-binding limits are documented in `docs/telegram-acp-usage.md`.

### Huragok ↔ Codex doctrine

Think of it this way:
- **Huragok = foreman**
- **Codex ACP = power tool**
- **Cortana/main = only ACP dispatcher**

Huragok stays **native by default** for:
- triage, diagnosis, and root-cause isolation
- small surgical fixes
- config/path/prompt tweaks
- PR review, merge judgment, and release confidence calls
- cross-system coordination
- high-reliability moments when provider/runtime stability matters more than throughput

Escalate to **Codex ACP** for:
- new feature implementation
- multi-file refactors
- repo exploration plus iterative coding
- test work that spans multiple files or loops
- explicit “ship a PR” / implementation-heavy build asks

Dispatcher rule:
- Huragok may recommend ACP escalation, but **does not spawn ACP directly**
- when Huragok wants ACP, the request must bubble to **Cortana/main**, which dispatches `agentId: "codex"`

Quick decision rule:
- User explicitly names Codex/Claude/Gemini or asks for "ACP" → spawn with `agentId: "codex"`
- User asks for code/infra work without naming a coding runtime → route to Huragok first
- Huragok determines the task is implementation-heavy enough for ACP → hand back to Cortana/main for ACP dispatch
- Otherwise → spawn normal Covenant role agent (`huragok`, `researcher`, `monitor`, `oracle`, `librarian`) per task type

For Researcher bootstrap + usage details, see `docs/researcher-bot-bootstrap.md`.

## Monitor/Covenant Telegram troubleshooting

If Monitor cannot see Covenant group messages, use:
- `docs/monitor-covenant-telegram-troubleshooting.md`

This covers routing keys, account bindings, group mention policy, and Telegram privacy/admin checks.

## Known Pitfall: Reply Routing

When a cron agent sends a message to Telegram (e.g., a health alert), **replying to that message may route your reply to the cron agent** instead of Cortana. The cron agent has a tiny siloed workspace with no access to Cortana's memory, identity, or conversation history.

**Workaround:** Start a new message to the bot instead of replying to a cron notification.

**Future fix:** Cron delivery messages should include a footer indicating they're automated, or OpenClaw should route all Telegram DM replies to the main agent regardless of which agent sent the original message.

## Identity Namespace Wiring (Covenant Slice 2)

Runtime now supports per-agent identity namespace selection via a local internal hook.

### Namespace config

- Source of truth: `config/identity-namespaces.json`
- Hook: `hooks/identity-namespace-bootstrap/handler.js`
- Runtime config entry: `hooks.internal.entries.identity-namespace-bootstrap`

Namespace files loaded (when present):
- `SOUL.md`
- `USER.md`
- `IDENTITY.md`
- `HEARTBEAT.md`
- `MEMORY.md`

If a namespace file is missing, the hook logs a warning and keeps the workspace default file (non-breaking fallback).

### Rollout

```bash
# 1) apply repo config updates
cp /Users/hd/Developer/cortana/config/openclaw.json ~/.openclaw/openclaw.json
cp /Users/hd/Developer/cortana/config/agent-profiles.json ~/.openclaw/agent-profiles.json

# 2) restart gateway
openclaw gateway restart

# 3) verify hook is active
openclaw hooks list | rg identity-namespace-bootstrap
```

### Rollback

```bash
# disable only namespace override hook
openclaw config set hooks.internal.entries.identity-namespace-bootstrap.enabled false
openclaw gateway restart
```

This rollback preserves all existing agent routing and reverts bootstrap identity loading to workspace defaults.

## Durable Memory Write Isolation (Covenant Slice 3)

Durable memory write destinations are now namespace-aware for identity agents.

- `main` writes to:
  - `/Users/hd/Developer/cortana/MEMORY.md`
  - `/Users/hd/Developer/cortana/memory/*.md`
- `researcher` writes to:
  - `/Users/hd/Developer/cortana/identities/researcher/MEMORY.md`
  - `/Users/hd/Developer/cortana/identities/researcher/memory/*.md`
- `huragok` writes to:
  - `/Users/hd/Developer/cortana/identities/huragok/MEMORY.md`
  - `/Users/hd/Developer/cortana/identities/huragok/memory/*.md`

### Fallback behavior (non-breaking)

If the resolved namespace memory path is missing (either `MEMORY.md` or `memory/`), runtime logs a warning and falls back to main memory paths.

### Rollout

```bash
cd /Users/hd/Developer/cortana
npm test -- tests/lib/identity-namespace.test.ts
openclaw gateway restart
```

### Rollback

```bash
cd /Users/hd/Developer/cortana
git revert <slice3_commit_sha>
openclaw gateway restart
```

### Caveats

- Fallback is intentional for safety; warning logs should be treated as drift that needs repair.
- Existing `main` memory behavior remains unchanged.
- This slice only routes write destinations; it does not alter Telegram/account routing.

## The "main" Agent Entry

The `main` agent MUST be explicitly listed in both:
- `config/agent-profiles.json` (in this repo)
- `~/.openclaw/openclaw.json` (system config)

Without an explicit entry, webchat falls back to `~/.openclaw/workspace-main` (a blank bootstrap workspace) instead of the Cortana workspace.

## Cross-Agent Visibility (Messaging + History)

If `sessions_send` works but cross-session history/listing is still limited, both of these config keys must be set in `~/.openclaw/openclaw.json`.

Reference snippet: `config/openclaw.cross-agent-visibility.example.json`


```json
{
  "tools": {
    "agentToAgent": {
      "enabled": true
    },
    "sessions": {
      "visibility": "all"
    }
  }
}
```

### Why both are needed

- `tools.agentToAgent.enabled=true` enables cross-agent operations (status/send/history) outside the same agent.
- `tools.sessions.visibility="all"` lifts session tool visibility from scoped values (`self`/`tree`/`agent`) so history/list/send can see other agent sessions.

If either is missing, OpenClaw intentionally blocks full cross-agent visibility.

### Optional tightening

If you need to restrict which agents can talk to each other, use `tools.agentToAgent.allow` (glob/IDs). Leaving it unset allows all agents once `enabled` is true.

### Migration note

If an older config still uses `routing.agentToAgent`, move it to `tools.agentToAgent`.


## Stable Ops Routing

Monitor is the user-facing owner lane for inbox/email ops and operational maintenance alerts.
