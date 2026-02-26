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
tools/spawn-preflight/preflight.sh --model openai-codex/gpt-5.3-codex --repo ~/clawd
```

You can also pass env vars:

```bash
MODEL=openai-codex/gpt-5.3-codex REPO_PATH=~/clawd tools/spawn-preflight/preflight.sh
```

## Output contract

- Success: exits `0` with
  ```json
  {"ready": true}
  ```
- Failure: exits `1` with
  ```json
  {"ready": false, "failures": ["..."]}
  ```
