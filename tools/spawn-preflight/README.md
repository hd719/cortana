# Spawn Pre-flight Validator

`preflight.sh` validates whether a sub-agent spawn is safe to run.

## Checks

1. **Model validation**
   - Allowed:
     - `openai-codex/gpt-5.3-codex`
     - `openai-codex/gpt-5.1`
     - `anthropic/claude-opus-4-6`
   - Rejects shorthand aliases like `codex`.
2. **Git auth**
   - Runs `ssh -T git@github.com`.
   - Treats exit code `1` as authenticated success.
3. **Repo existence**
   - Repo path must exist and be a git repository.
4. **Branch readiness**
   - `main` branch must exist.
   - `main` must be currently checked out.
   - If on `main`, validates `git pull --ff-only --dry-run` succeeds.

## Usage

```bash
tools/spawn-preflight/preflight.sh --model openai-codex/gpt-5.3-codex --repo ~/Developer/cortana
```

You can also pass env vars:

```bash
MODEL=openai-codex/gpt-5.3-codex REPO_PATH=~/Developer/cortana tools/spawn-preflight/preflight.sh
```

## Retry Engine (`retry-engine.sh`)

Adds spawn failure analytics and targeted retries using `cortana_events`.

### Commands

```bash
# Analyze recent spawn failures (default: 24h, 100 rows)
tools/spawn-preflight/retry-engine.sh analyze

# Retry a specific failed spawn event id
tools/spawn-preflight/retry-engine.sh retry <event_id>
```

### Failure patterns

- `model_routing_error` → retries with full model path
- `timeout` → retries with extended timeout
- `rate_limit` → retries with exponential backoff
- `oom` and `unknown` → reports recommendation

### Event logging

- Reads failures from `cortana_events` where `event_type='spawn_failed'`
- Logs each retry attempt as `event_type='spawn_retry'`
- If retry fails, logs a new `event_type='spawn_failed'`

All command responses are emitted as JSON.

## Output contract

- Success: exits `0` with
  ```json
  {"ready": true}
  ```
- Failure: exits `1` with
  ```json
  {"ready": false, "failures": ["..."]}
  ```
