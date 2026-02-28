# Local Inference Failsafe: API-Outage Survival Brain

## Objective
Provide a local inference fallback path on Apple Silicon so critical automation still functions during OpenAI/Anthropic outages.

## Decision Summary
Compared three viable stacks for Apple Silicon M-series:

1. **llama.cpp**
   - Pros: Fast, lightweight, flexible GGUF ecosystem.
   - Cons: More manual runtime/model management for day-to-day operations.

2. **MLX (Apple-native)**
   - Pros: Excellent Apple Silicon performance and memory efficiency.
   - Cons: Less turnkey for operations workflows unless wrapped in extra tooling.

3. **Ollama (selected)**
   - Pros: Simplest operator UX (`ollama pull/run`), robust local server, easy model lifecycle.
   - Cons: Slightly less raw tuning flexibility than direct llama.cpp/MLX workflows.

**Recommendation:** Ollama for failsafe reliability and operational simplicity.

## What was installed
- `ollama` via Homebrew (`0.17.0`)
- Service started with `brew services start ollama`
- Local model pulled: `phi3:mini` (small and capable for emergency Q&A/triage)

## Failsafe script
Path: `~/openclaw/tools/failsafe/local-inference.py`

### Capabilities
- Detects remote API outage by probing:
  - OpenAI: `GET /v1/models`
  - Anthropic: `POST /v1/messages`
- Considers outage when both providers are unreachable (timeout/connection/5xx).
- Falls back to local Ollama model for:
  - `task_queue` (ready-task summarization + sequencing)
  - `alert` (concise operator alert copy)
  - `qa` (basic Q&A)
- Logs failover events to `cortana_events`.

### Logging behavior
On failover:
- `event_type='failover'`
- `source='local-inference'`
- `severity='warning'`
- Includes outage details + selected mode/model in JSON metadata.

On fallback failure:
- `event_type='failover_error'`
- `severity='error'`

## Usage
```bash
# Force local path (testing)
python3 ~/openclaw/tools/failsafe/local-inference.py qa \
  --prompt "Say local failsafe online" \
  --force-local

# Automatic failover path (checks remote APIs first)
python3 ~/openclaw/tools/failsafe/local-inference.py qa \
  --prompt "What should we do if gateway is down?"

# Task queue mode
python3 ~/openclaw/tools/failsafe/local-inference.py task_queue --limit 10

# Alert mode
python3 ~/openclaw/tools/failsafe/local-inference.py alert \
  --prompt "Watchdog reports PostgreSQL restart loop"
```

## Environment knobs
- `FAILSAFE_MODEL` (default: `phi3:mini`)
- `FAILSAFE_TIMEOUT_SEC` (default: `6`)
- `CORTANA_DB` (default: `cortana`)
- `PSQL_PATH` (default: `/opt/homebrew/opt/postgresql@17/bin/psql`)

## Notes
- If API keys are missing, remote checks are treated as not reachable and fallback engages.
- Keep at least one small local model pre-pulled for cold-start-free failover.
- For higher quality local responses, optional swap candidates:
  - `mistral:7b-instruct`
  - `qwen2.5:7b`
  (higher VRAM/RAM and latency cost)
