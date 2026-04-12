#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXTERNAL_ROOT="${CORTANA_EXTERNAL_ROOT:-$HOME/Developer/cortana-external}"
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"

if ! command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
  echo "openclaw CLI not found in PATH" >&2
  exit 1
fi

if [[ ! -d "$EXTERNAL_ROOT" ]]; then
  echo "cortana-external repo not found at $EXTERNAL_ROOT" >&2
  exit 1
fi

declare -a SOURCES=(
  "$ROOT/README.md|Cortana Workspace Overview"
  "$ROOT/docs/README.md|Cortana Source Docs Overview"
  "$ROOT/knowledge/indexes/systems.md|Cortana Systems Index"
  "$EXTERNAL_ROOT/README.md|Cortana External Runtime Overview"
  "$EXTERNAL_ROOT/docs/README.md|Cortana External Docs Overview"
  "$EXTERNAL_ROOT/knowledge/indexes/systems.md|Cortana External Systems Index"
)

ingest_source() {
  local path="$1"
  local title="$2"
  if [[ ! -f "$path" ]]; then
    echo "missing source file: $path" >&2
    exit 1
  fi
  "$OPENCLAW_BIN" wiki ingest "$path" --title "$title" --json >/dev/null
}

apply_synthesis() {
  local title="$1"
  local body_file="$2"
  shift 2
  "$OPENCLAW_BIN" wiki apply synthesis "$title" \
    --body-file "$body_file" \
    --status active \
    "$@" \
    --json >/dev/null
}

for entry in "${SOURCES[@]}"; do
  IFS='|' read -r path title <<<"$entry"
  ingest_source "$path" "$title"
done

repo_topology_body="$(mktemp)"
docs_topology_body="$(mktemp)"
trap 'rm -f "$repo_topology_body" "$docs_topology_body"' EXIT

cat >"$repo_topology_body" <<'EOF'
Cortana is split into two cooperating repos. `cortana` is the command brain: doctrine, memory, routing, cron prompts, and internal automation. `cortana-external` is the runtime edge: Mission Control, Trading Ops, and external-service truth surfaces. The operating model is deliberate: source docs and durable policy live in the brain repo, while execution-facing dashboards and runtime interfaces live in the external repo.
EOF

cat >"$docs_topology_body" <<'EOF'
Documentation follows a layered model. Repo-root doctrine and `memory/` hold live operating context, `docs/source/` stores durable source artifacts, and `knowledge/` holds compiled current-truth indexes and domain pages. The isolated OpenClaw memory wiki is adjacent runtime state: it can inspect imported or ingested material in Dreaming, but it is not the source of truth unless insights are intentionally promoted back into tracked docs or curated memory.
EOF

apply_synthesis \
  "Cortana Repo Topology" \
  "$repo_topology_body" \
  --confidence 0.95 \
  --source-id source.cortana-workspace-overview \
  --source-id source.cortana-external-runtime-overview

apply_synthesis \
  "Cortana Documentation Topology" \
  "$docs_topology_body" \
  --confidence 0.92 \
  --source-id source.cortana-source-docs-overview \
  --source-id source.cortana-systems-index \
  --source-id source.cortana-external-docs-overview \
  --source-id source.cortana-external-systems-index

"$OPENCLAW_BIN" wiki compile --json
