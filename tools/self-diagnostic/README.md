# self-diagnostic

Unified Cortana health diagnostic command.

## What it checks

1. `cortana_self_model` singleton row (`id=1`)
2. `cortana_cron_health` last 24h (latest status per cron + failure highlighting)
3. `cortana_tool_health` last 24h (latest status per tool + outage highlighting)
4. `cortana_budget_log` latest burn/projection snapshot
5. Memory coherence:
   - `~/openclaw/MEMORY.md` size + last modified
   - daily note existence for today and yesterday (`~/openclaw/memory/YYYY-MM-DD.md`)
6. Session bloat in `~/.openclaw/agents/main/sessions/*.jsonl` (>400 KB)

## Usage

```bash
~/openclaw/tools/self-diagnostic/self-diagnostic.sh
~/openclaw/tools/self-diagnostic/self-diagnostic.sh --brief
~/openclaw/tools/self-diagnostic/self-diagnostic.sh --json
```

## Output modes

- **Default (no flag):** full formatted report with section statuses (`✅ / ⚠️ / ❌`)
- `--brief`: one-line summary
- `--json`: machine-readable JSON for downstream automation

## Dependencies

- PostgreSQL client: `/opt/homebrew/opt/postgresql@17/bin/psql`
- Database: `cortana`
- `python3` for formatting/JSON shaping

If DB is unavailable, the script degrades gracefully and marks missing sections as warning/fail in output.
