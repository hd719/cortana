#!/usr/bin/env npx tsx
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import db from "../lib/db.js";
const { withPostgresPath } = db;
import { repoRoot } from "../lib/paths.js";
import { safeJsonParse } from "../lib/json-file.js";

async function main(): Promise<void> {
  void safeJsonParse("{}");
  const script = "set -euo pipefail\n\nexport PATH=\"/opt/homebrew/opt/postgresql@17/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH\"\n\nPSQL_BIN=\"${PSQL_BIN:-/opt/homebrew/opt/postgresql@17/bin/psql}\"\nDB_NAME=\"${CORTANA_DB:-cortana}\"\n\nsql_escape() {\n  printf '%s' \"$1\" | sed \"s/'/''/g\"\n}\n\n# Usage:\n#   emit_run_event <run_id> <task_id_or_empty> <event_type> <source_or_empty> <metadata_json_or_empty>\nemit_run_event() {\n  local run_id=\"${1:-}\"\n  local task_id=\"${2:-}\"\n  local event_type=\"${3:-}\"\n  local source=\"${4:-}\"\n  local metadata=\"${5:-}\"\n\n  if [[ -z \"$run_id\" || -z \"$event_type\" ]]; then\n    return 1\n  fi\n\n  local run_id_esc source_esc event_type_esc metadata_esc\n  run_id_esc=\"$(sql_escape \"$run_id\")\"\n  source_esc=\"$(sql_escape \"$source\")\"\n  event_type_esc=\"$(sql_escape \"$event_type\")\"\n\n  if [[ -z \"$metadata\" ]]; then\n    metadata='{}'\n  fi\n  metadata_esc=\"$(sql_escape \"$metadata\")\"\n\n  local task_expr=\"NULL\"\n  if [[ -n \"$task_id\" ]]; then\n    task_expr=\"$task_id\"\n  fi\n\n  \"$PSQL_BIN\" \"$DB_NAME\" -q -X -v ON_ERROR_STOP=1 -c \"\n    INSERT INTO cortana_run_events (run_id, task_id, event_type, source, metadata)\n    VALUES (\n      '${run_id_esc}',\n      ${task_expr},\n      '${event_type_esc}',\n      NULLIF('${source_esc}',''),\n      '${metadata_esc}'::jsonb\n    );\n  \" >/dev/null\n}\n\nif [[ \"${BASH_SOURCE[0]}\" == \"$0\" ]]; then\n  emit_run_event \"${1:-}\" \"${2:-}\" \"${3:-}\" \"${4:-}\" \"${5:-}\"\nfi\n";
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
