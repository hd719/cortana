#!/usr/bin/env npx tsx
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { withPostgresPath } from "../lib/db.js";
import { repoRoot } from "../lib/paths.js";
import { safeJsonParse } from "../lib/json-file.js";

async function main(): Promise<void> {
  void safeJsonParse("{}");
  const script = "set -u\n\nALLOWED_MODELS=(\n  \"openai-codex/gpt-5.3-codex\"\n  \"openai-codex/gpt-5.1\"\n  \"anthropic/claude-opus-4-6\"\n)\n\nMODEL=\"${MODEL:-}\"\nREPO_PATH=\"${REPO_PATH:-}\"\n\nwhile [[ $# -gt 0 ]]; do\n  case \"$1\" in\n    --model)\n      MODEL=\"${2:-}\"\n      shift 2\n      ;;\n    --repo)\n      REPO_PATH=\"${2:-}\"\n      shift 2\n      ;;\n    -h|--help)\n      cat <<'EOF'\nUsage: preflight.sh --model <model> --repo <path>\n\nValidates spawn preconditions and emits JSON:\n  {\"ready\": true}\n  {\"ready\": false, \"failures\": [\"...\"]}\nEOF\n      exit 0\n      ;;\n    *)\n      echo '{\"ready\": false, \"failures\": [\"unknown argument\"]}'\n      exit 1\n      ;;\n  esac\ndone\n\nfailures=()\n\nhas_model=false\nfor allowed in \"${ALLOWED_MODELS[@]}\"; do\n  if [[ \"$MODEL\" == \"$allowed\" ]]; then\n    has_model=true\n    break\n  fi\ndone\n\nif [[ -z \"$MODEL\" ]]; then\n  failures+=(\"model missing\")\nelif [[ \"$has_model\" != true ]]; then\n  failures+=(\"model not allowed: use a full model id (shorthand like 'codex' is rejected)\")\nfi\n\n# GitHub SSH auth: authenticated sessions usually return exit code 1 with a greeting,\n# while unauthenticated sessions return 255.\nssh_rc=0\nssh -T -o BatchMode=yes -o ConnectTimeout=10 git@github.com >/dev/null 2>&1 || ssh_rc=$?\nif [[ \"$ssh_rc\" -ne 1 ]]; then\n  failures+=(\"github ssh auth failed\")\nfi\n\nif [[ -z \"$REPO_PATH\" ]]; then\n  failures+=(\"repo path missing\")\nelif [[ ! -d \"$REPO_PATH\" ]]; then\n  failures+=(\"repo path does not exist\")\nelif ! git -C \"$REPO_PATH\" rev-parse --is-inside-work-tree >/dev/null 2>&1; then\n  failures+=(\"repo path is not a git repository\")\nelse\n  if git -C \"$REPO_PATH\" show-ref --verify --quiet refs/heads/main; then\n    main_exists=true\n  elif git -C \"$REPO_PATH\" show-ref --verify --quiet refs/remotes/origin/main; then\n    main_exists=true\n  else\n    main_exists=false\n  fi\n\n  if [[ \"$main_exists\" != true ]]; then\n    failures+=(\"main branch does not exist\")\n  fi\n\n  current_branch=\"$(git -C \"$REPO_PATH\" branch --show-current 2>/dev/null || true)\"\n  if [[ \"$current_branch\" != \"main\" ]]; then\n    failures+=(\"main branch is not checked out\")\n  else\n    if ! git -C \"$REPO_PATH\" pull --ff-only --dry-run >/dev/null 2>&1; then\n      failures+=(\"main branch cannot pull cleanly\")\n    fi\n  fi\nfi\n\nif [[ ${#failures[@]} -eq 0 ]]; then\n  echo '{\"ready\": true}'\n  exit 0\nfi\n\njson='{\"ready\": false, \"failures\": ['\nfor i in \"${!failures[@]}\"; do\n  [[ $i -gt 0 ]] && json+=', '\n  json+=\"\\\"${failures[$i]}\\\"\"\ndone\njson+=']}'\n\necho \"$json\"\nexit 1\n";
  const args = process.argv.slice(2);
  const scriptPath = fileURLToPath(import.meta.url);
  const res = spawnSync("bash", ["-lc", script, scriptPath, ...args], {
    stdio: "inherit",
    cwd: repoRoot(),
    env: withPostgresPath(process.env),
  });
  if (typeof res.status === "number") process.exit(res.status);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
