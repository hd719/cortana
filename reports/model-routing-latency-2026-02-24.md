# Model Routing Latency Check — 2026-02-24

## Scope
After switching to Codex-first routing:
- main: `openai-codex/gpt-5.3-codex`
- heavy: `openai-codex/gpt-5.2-codex`
- medium: `openai-codex/gpt-5.1-codex-max`
- fast ops: `openai-codex/gpt-5.1`

## Sample Runs (forced manual runs)

| Cron | Model | Before (ms) | After (ms) | Status |
|---|---|---:|---:|---|
| Proprioception: Cron & Tool Health | gpt-5.1 | 15,298 | 21,567 | ok |
| Proprioception: Budget & Self-Model | gpt-5.1 | 91,652 | 8,374 | ok |
| Immune Scan | gpt-5.1 | 18,783 | 60,015 | error (timeout) |
| SAE World State Builder | gpt-5.2-codex | 155,037 | 219,880 | ok |

## Notes
- This is a **small sample** and includes one timeout outlier (Immune Scan).
- Immune Scan timeout appears to be a job timeout tuning issue (`timeoutSeconds=60`), not necessarily model quality.
- The routing change is applied; reliable verdict needs a 24-hour run window.

## Next 24h Evaluation Plan
1. Capture all cron run durations for same jobs over next 24h.
2. Report p50/p95 and error rate by model tier.
3. Adjust timeout for specific jobs with repeated timeout patterns.

