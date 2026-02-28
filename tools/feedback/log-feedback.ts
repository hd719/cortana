#!/usr/bin/env npx tsx

import { randomUUID } from "crypto";
import { spawnSync } from "child_process";
import { withPostgresPath } from "../lib/db.js";
import { PSQL_BIN } from "../lib/paths.js";

const args = process.argv.slice(2);

if (args.length < 3) {
  console.error(
    `Usage: ${process.argv[1] ?? "log-feedback.ts"} <category> <severity> <summary> [details_json] [agent_id] [task_id]`
  );
  process.exit(1);
}

const [category, severity, summary, detailsJsonRaw, agentIdRaw, taskIdRaw] = args;
const detailsJson = detailsJsonRaw && detailsJsonRaw.trim() !== "" ? detailsJsonRaw : "{}";
const agentId = agentIdRaw ?? "";
const taskId = taskIdRaw ?? "";
const source = "user";
const status = "new";
const feedbackId = randomUUID().toLowerCase();

const isUuid = (value: string) =>
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    value
  );

const extractLesson = (raw: string): string => {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const lessonValue = (parsed as { lesson?: unknown }).lesson;
      return lessonValue ? String(lessonValue) : "";
    }
  } catch {
    return "";
  }
  return "";
};

const buildRecurrenceKey = (raw: string, fallback: string): string => {
  let lesson = "";
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const lessonValue = (parsed as { lesson?: unknown }).lesson;
        lesson = lessonValue ? String(lessonValue) : "";
      }
    } catch {
      lesson = "";
    }
  }

  const base = lesson || fallback;
  const normalized = base.toLowerCase().trim().replace(/\s+/g, " ");
  const cleaned = normalized.replace(/[^a-z0-9 ]/g, "");
  return cleaned.slice(0, 50).trim();
};

const recurrenceKey = buildRecurrenceKey(detailsJson, summary ?? "");
const lessonText = extractLesson(detailsJson);

let feedbackType = "correction";
switch (category) {
  case "correction":
    feedbackType = "correction";
    break;
  case "preference":
    feedbackType = "preference";
    break;
  case "policy":
    feedbackType = severity === "low" ? "approval" : "rejection";
    break;
  default:
    feedbackType = "correction";
    break;
}

const escapeSql = (value: string) => value.replace(/'/g, "''");

const safeDetails = escapeSql(detailsJson);
const safeSummary = escapeSql(summary ?? "");
const safeAgentId = escapeSql(agentId);
const safeRecurrence = escapeSql(recurrenceKey);
const safeLesson = escapeSql(lessonText);

const taskSql = taskId && isUuid(taskId) ? `'${taskId}'::uuid` : "NULL";
const agentSql = agentId ? `'${safeAgentId}'` : "NULL";
const recurrenceSql = recurrenceKey ? `'${safeRecurrence}'` : "NULL";

const sql1 = `
INSERT INTO mc_feedback_items (id, task_id, agent_id, source, category, severity, summary, details, recurrence_key, status)
VALUES (
  '${feedbackId}'::uuid,
  ${taskSql},
  ${agentSql},
  '${source}',
  '${category}',
  '${severity}',
  '${safeSummary}',
  '${safeDetails}'::jsonb,
  ${recurrenceSql},
  '${status}'
);
`;

const sql2 = `
INSERT INTO cortana_feedback (feedback_type, context, lesson, applied)
VALUES (
  '${feedbackType}',
  '${safeSummary}',
  '${safeLesson}',
  FALSE
);
`;

const result = spawnSync(PSQL_BIN, ["cortana", "-q", "-c", sql1, "-q", "-c", sql2], {
  encoding: "utf8",
  stdio: ["ignore", "ignore", "inherit"],
  env: withPostgresPath(process.env),
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(feedbackId);
