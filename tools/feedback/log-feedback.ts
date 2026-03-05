#!/usr/bin/env npx tsx

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { withPostgresPath } from "../lib/db.js";
import { PSQL_BIN } from "../lib/paths.js";

function isUuid(value: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

function esc(v: string): string {
  return v.replace(/'/g, "''");
}

function lessonFromDetails(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const lesson = (parsed as Record<string, unknown>).lesson;
      return lesson == null ? "" : String(lesson);
    }
  } catch {
    return "";
  }
  return "";
}

function recurrenceKey(detailsJson: string, summary: string): string {
  const lesson = lessonFromDetails(detailsJson);
  const base = lesson || summary;
  return base.toLowerCase().trim().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").slice(0, 50).trim();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error(`Usage: ${process.argv[1] ?? "log-feedback.ts"} <category> <severity> <summary> [details_json] [agent_id] [task_id]`);
    process.exit(1);
  }

  const category = args[0] ?? "";
  const severity = args[1] ?? "";
  const summary = args[2] ?? "";
  const detailsJson = args[3] && args[3].length > 0 ? args[3] : "{}";
  const agentId = args[4] ?? "";
  const taskId = args[5] ?? "";
  const source = "user";
  const status = "new";
  const feedbackId = randomUUID();

  let feedbackType = "correction";
  if (category === "preference") feedbackType = "preference";
  if (category === "policy") feedbackType = severity === "low" ? "approval" : "rejection";

  const lesson = lessonFromDetails(detailsJson);
  const key = recurrenceKey(detailsJson, summary);

  const taskSql = taskId && isUuid(taskId) ? `'${taskId}'::uuid` : "NULL";
  const agentSql = agentId ? `'${esc(agentId)}'` : "NULL";
  const recurrenceSql = key ? `'${esc(key)}'` : "NULL";

  const sql1 = `
INSERT INTO mc_feedback_items (id, task_id, agent_id, source, category, severity, summary, details, recurrence_key, status)
VALUES (
  '${feedbackId}'::uuid,
  ${taskSql},
  ${agentSql},
  '${source}',
  '${category}',
  '${severity}',
  '${esc(summary)}',
  '${esc(detailsJson)}'::jsonb,
  ${recurrenceSql},
  '${status}'
);
`;

  const sql2 = `
INSERT INTO cortana_feedback (feedback_type, context, lesson, applied)
VALUES (
  '${feedbackType}',
  '${esc(summary)}',
  '${esc(lesson)}',
  FALSE
);
`;

  const r = spawnSync(PSQL_BIN, ["cortana", "-q", "-c", sql1, "-q", "-c", sql2], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "inherit"],
    env: withPostgresPath(process.env),
  });

  if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);
  console.log(feedbackId);
}

main();
