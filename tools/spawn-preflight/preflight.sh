#!/usr/bin/env bash
set -u

ALLOWED_MODELS=(
  "openai-codex/gpt-5.3-codex"
  "openai-codex/gpt-5.1"
  "anthropic/claude-opus-4-6"
)

MODEL="${MODEL:-}"
REPO_PATH="${REPO_PATH:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --repo)
      REPO_PATH="${2:-}"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Usage: preflight.sh --model <model> --repo <path>

Validates spawn preconditions and emits JSON:
  {"ready": true}
  {"ready": false, "failures": ["..."]}
EOF
      exit 0
      ;;
    *)
      echo '{"ready": false, "failures": ["unknown argument"]}'
      exit 1
      ;;
  esac
done

failures=()

has_model=false
for allowed in "${ALLOWED_MODELS[@]}"; do
  if [[ "$MODEL" == "$allowed" ]]; then
    has_model=true
    break
  fi
done

if [[ -z "$MODEL" ]]; then
  failures+=("model missing")
elif [[ "$has_model" != true ]]; then
  failures+=("model not allowed: use a full model id (shorthand like 'codex' is rejected)")
fi

# GitHub SSH auth: authenticated sessions usually return exit code 1 with a greeting,
# while unauthenticated sessions return 255.
ssh_rc=0
ssh -T -o BatchMode=yes -o ConnectTimeout=10 git@github.com >/dev/null 2>&1 || ssh_rc=$?
if [[ "$ssh_rc" -ne 1 ]]; then
  failures+=("github ssh auth failed")
fi

if [[ -z "$REPO_PATH" ]]; then
  failures+=("repo path missing")
elif [[ ! -d "$REPO_PATH" ]]; then
  failures+=("repo path does not exist")
elif ! git -C "$REPO_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  failures+=("repo path is not a git repository")
else
  if git -C "$REPO_PATH" show-ref --verify --quiet refs/heads/main; then
    main_exists=true
  elif git -C "$REPO_PATH" show-ref --verify --quiet refs/remotes/origin/main; then
    main_exists=true
  else
    main_exists=false
  fi

  if [[ "$main_exists" != true ]]; then
    failures+=("main branch does not exist")
  fi

  current_branch="$(git -C "$REPO_PATH" branch --show-current 2>/dev/null || true)"
  if [[ "$current_branch" != "main" ]]; then
    failures+=("main branch is not checked out")
  else
    if ! git -C "$REPO_PATH" pull --ff-only --dry-run >/dev/null 2>&1; then
      failures+=("main branch cannot pull cleanly")
    fi
  fi
fi

if [[ ${#failures[@]} -eq 0 ]]; then
  echo '{"ready": true}'
  exit 0
fi

json='{"ready": false, "failures": ['
for i in "${!failures[@]}"; do
  [[ $i -gt 0 ]] && json+=', '
  json+="\"${failures[$i]}\""
done
json+=']}'

echo "$json"
exit 1
