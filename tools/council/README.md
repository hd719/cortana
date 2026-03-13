# Council CLI Tools

Council is a lightweight decision layer for Cortana's multi-agent workflow. It tracks decision sessions, individual votes, and immutable event logs in PostgreSQL.

## Components

- `council.sh` — main CLI for session lifecycle (`create`, `vote`, `decide`, `status`, `list`, `expire`)
- `council-deliberate.sh` — create a deliberation session and return session metadata for agent fan-out
- `council-tally.sh` — aggregate votes, synthesize outcome, and finalize session decision

All tools write JSON output for machine parsing and log actions to `cortana_council_events`.

## Database

Uses local Postgres database `cortana`.

```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
```

Tables (pre-existing):
- `cortana_council_sessions`
- `cortana_council_votes`
- `cortana_council_events`

## Model Tiering Policy

- **Approvals:** free / minimal-cost models (fast consensus checks)
- **Eval gates:** cheap models for routine pass/fail scoring
- **Deliberations:** cheap voter models + frontier synthesis model for final recommendation

This keeps routine decisions inexpensive while preserving quality for high-stakes synthesis.

## Example Workflows

### 1) Simple approval flow

```bash
~/Developer/cortana/tools/council/council.sh create \
  --type approval \
  --title "Deploy to prod" \
  --initiator cortana \
  --participants "oracle,researcher" \
  --expires 60 \
  --context '{"action":"deploy","risk":"high"}'

~/Developer/cortana/tools/council/council.sh vote \
  --session <UUID> \
  --voter oracle \
  --vote approve \
  --confidence 0.85 \
  --reasoning "Low risk change" \
  --model "openai/gpt-4o-mini" \
  --tokens 150

~/Developer/cortana/tools/council/council.sh decide \
  --session <UUID> \
  --decision '{"outcome":"approved","reasoning":"Unanimous approval"}'
```

### 2) Deliberation fan-out + tally

```bash
~/Developer/cortana/tools/council/council-deliberate.sh \
  --title "Portfolio rebalancing strategy" \
  --participants "oracle,researcher" \
  --context '{"question":"Should we diversify out of 95% tech?"}' \
  --expires 30

# Cortana spawns participant agents to cast votes...

~/Developer/cortana/tools/council/council-tally.sh --session <UUID>
```

### 3) Housekeeping

```bash
~/Developer/cortana/tools/council/council.sh list --status open --type deliberation
~/Developer/cortana/tools/council/council.sh status --session <UUID>
~/Developer/cortana/tools/council/council.sh expire
```

## Notes

- Scripts are designed for agent use (stable JSON outputs).
- `council-tally.sh` decides by majority + confidence weighting.
- Every create/vote/decide/expire/tally action writes to the event log.
