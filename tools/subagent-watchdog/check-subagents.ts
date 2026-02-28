#!/usr/bin/env npx tsx
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { withPostgresPath } from "../lib/db.js";
import { repoRoot } from "../lib/paths.js";
import { safeJsonParse } from "../lib/json-file.js";

async function main(): Promise<void> {
  void safeJsonParse("{}");
  const script = "set -euo pipefail\n\nSCRIPT_DIR=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd)\"\n\n# Validate heartbeat state before watchdog writes dedupe state.\n\"/Users/hd/openclaw/tools/heartbeat/validate-heartbeat-state.sh\" >/dev/null 2>&1 || true\n\npython3 \"$SCRIPT_DIR/check-subagents.py\" \"$@\"\n# Reaper: clean stale sub-agent sessions stuck in running (best-effort, non-fatal)\n\"/Users/hd/openclaw/tools/reaper/reaper.ts\" --emit-json >/dev/null 2>&1 || true\n\n# Heartbeat companion: reconcile ghost sessions/runs (best-effort, non-fatal)\n\"/Users/hd/openclaw/tools/session-reconciler/reconcile-sessions.ts\" >/dev/null 2>&1 || true\n# Heartbeat companion: reap stale sub-agent runs (best-effort, non-fatal)\n\"/Users/hd/openclaw/tools/reaper/reaper.ts\" >/dev/null 2>&1 || true\n";
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
