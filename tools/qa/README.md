# QA System Validation Suite

`validate-system` runs a critical-path health validation for this repo/runtime and reports pass/fail per check.

## Files

- `validate-system.py` — main validator (Python stdlib only)
- `validate-system.sh` — shell wrapper

## Checks

1. Runtime cron deploy integrity (`config/cron/jobs.json` semantically aligned with `~/.openclaw/cron/jobs.json`)
2. Cron definitions (`config/cron/jobs.json` required fields + missing `model` flag)
3. PostgreSQL connectivity and required `cortana` tables
4. Critical executable tools (required + optional-if-present)
5. Heartbeat state file integrity and version (`>= 2`)
6. Memory files present and non-empty (`MEMORY.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`)
7. Git working tree status summary (modified/untracked counts)
8. Root disk free space warning when `< 5GB`

## Usage

```bash
# green baseline sweep for OpenClaw + repo/runtime health
./tools/qa/green-baseline.sh

# human-readable validator summary
npx tsx tools/qa/validate-system.ts

# structured JSON output
npx tsx tools/qa/validate-system.ts --json

# auto-fix recoverable issues (currently: runtime cron sync)
npx tsx tools/qa/validate-system.ts --fix
```

## Exit codes

- `0` — no failing checks
- `1` — one or more checks failed

Warnings (e.g., low disk, missing cron `model`) do not change exit code unless a hard failure also exists.
