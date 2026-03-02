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

## Channel Routing

- **Telegram DMs** → `main` agent (Cortana)
- **Webchat** → `main` agent (Cortana)
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
