#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { withPostgresPath } from "../lib/db.js";
import { PSQL_BIN } from "../lib/paths.js";

function runPsql(sql: string, args: string[] = []): { ok: boolean; out: string } {
  const res = spawnSync(PSQL_BIN, ["cortana", ...args, "-c", sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: withPostgresPath(process.env),
  });
  return { ok: (res.status ?? 1) === 0, out: res.stdout ?? "" };
}

function esc(v: string): string {
  return v.replace(/'/g, "''");
}

async function main(): Promise<void> {
  const fetch = runPsql("SELECT id::text, category, severity FROM mc_feedback_items WHERE status='new' ORDER BY created_at ASC;", ["-t", "-A", "-F", "\t"]);
  const result = fetch.out.trim();

  if (!result) {
    console.log("Auto-remediation summary:");
    console.log("- New feedback items scanned: 0");
    console.log("- Items triaged: 0");
    console.log("- Actions created: 0");
    process.exit(0);
  }

  let scanned = 0;
  let triaged = 0;
  let actions = 0;

  for (const line of result.split("\n")) {
    if (!line.trim()) continue;
    const [feedbackId = "", category = "", severity = ""] = line.split("\t");
    if (!feedbackId) continue;
    scanned += 1;

    let actionType = "";
    switch (`${category}:${severity}`) {
      case "correction:high":
      case "correction:critical":
        actionType = "policy_rule";
        break;
      case "correction:medium":
      default:
        if (`${category}:${severity}` === "correction:medium" || category === "preference") {
          actionType = "prompt_patch";
        }
        break;
    }

    if (actionType) {
      const sql = `
UPDATE mc_feedback_items
SET status = 'triaged', updated_at = NOW()
WHERE id = '${feedbackId}'::uuid;

INSERT INTO mc_feedback_actions (feedback_id, action_type, description, status)
VALUES (
  '${feedbackId}'::uuid,
  '${actionType}',
  'Auto-remediation for ${esc(category)}/${esc(severity)}',
  'planned'
);
`;
      const update = spawnSync(PSQL_BIN, ["cortana"], {
        input: sql,
        encoding: "utf8",
        stdio: ["pipe", "ignore", "inherit"],
        env: withPostgresPath(process.env),
      });
      if ((update.status ?? 1) !== 0) process.exit(update.status ?? 1);
      triaged += 1;
      actions += 1;
    }
  }

  console.log("Auto-remediation summary:");
  console.log(`- New feedback items scanned: ${scanned}`);
  console.log(`- Items triaged: ${triaged}`);
  console.log(`- Actions created: ${actions}`);
}

main();
