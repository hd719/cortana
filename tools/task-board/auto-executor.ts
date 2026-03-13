#!/usr/bin/env npx tsx
import path from "node:path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { withPostgresPath } from "../lib/db.js";
import { externalRepoRoot, repoRoot } from "../lib/paths.js";
import { safeJsonParse } from "../lib/json-file.js";

async function main(): Promise<void> {
  void safeJsonParse("{}");
  const args = process.argv.slice(2);
  const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "auto-executor.sh");
  const res = spawnSync("bash", [scriptPath, ...args], {
    stdio: "inherit",
    cwd: repoRoot(),
    env: withPostgresPath({
      ...process.env,
      CORTANA_SOURCE_REPO: process.env.CORTANA_SOURCE_REPO ?? repoRoot(),
      CORTANA_EXTERNAL_REPO: process.env.CORTANA_EXTERNAL_REPO ?? externalRepoRoot(),
    }),
  });
  if (typeof res.status === "number") process.exit(res.status);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
