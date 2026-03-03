# Agent Routing Architecture

## Overview

This system runs multiple agents, each with its own workspace, model, and session scope. Understanding routing prevents "who am I talking to?" confusion.

## Agents

| Agent | Purpose | Workspace | Model | Accepts DMs? |
|-------|---------|-----------|-------|-------------|
| **main** (Cortana) | Primary assistant, conversation, coordination | `/Users/hd/openclaw` | opus | Yes (Telegram, webchat) |
| cron-health | Health checks (X session, fitness service, etc.) | `~/.openclaw/workspaces/cron-health` | gpt-5.1 | No — cron only |
| cron-comms | Communication checks | `~/.openclaw/workspaces/cron-comms` | gpt-5.3-codex | No — cron only |
| cron-fitness | Fitness data | `~/.openclaw/workspaces/cron-fitness` | gpt-5.3-codex | No — cron only |
| cron-market | Market analysis | `~/.openclaw/workspaces/cron-market` | gpt-5.3-codex | No — cron only |
| cron-maintenance | System updates | `~/.openclaw/workspaces/cron-maintenance` | gpt-5.1 | No — cron only |
| **huragok** | Telegram infra lane for Huragok group/chat entrypoint | `/Users/hd/openclaw` | gpt-5.3-codex | Yes (bound group/channel) |
| huragok-worker | Worker profile for spawned task runs from Huragok lane | `/Users/hd/openclaw` | gpt-5.3-codex | No — spawn target only |

## Channel Routing

- **Telegram DMs** → `main` agent (Cortana)
- **Webchat** → `main` agent (Cortana)
- **Telegram group `-5229462108`** → `huragok` (direct infra lane)
- **Huragok spawned work** → `huragok-worker` (`agentId: "huragok-worker"`)
- **Cron jobs** → respective cron agent (deliver results to Telegram via `message` tool)

## Known Pitfall: Reply Routing

When a cron agent sends a message to Telegram (e.g., a health alert), **replying to that message may route your reply to the cron agent** instead of Cortana. The cron agent has a tiny siloed workspace with no access to Cortana's memory, identity, or conversation history.

**Workaround:** Start a new message to the bot instead of replying to a cron notification.

**Future fix:** Cron delivery messages should include a footer indicating they're automated, or OpenClaw should route all Telegram DM replies to the main agent regardless of which agent sent the original message.

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
