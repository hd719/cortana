#!/usr/bin/env npx tsx

/** Agent Feedback Compiler (AFC). */

import { runPsql, withPostgresPath } from "../lib/db.js";

const DB_NAME = "cortana";

const AGENT_KEYWORDS: Record<string, string[]> = {
  huragok: ["huragok", "implement", "build", "code", "migration", "infra", "branch", "git"],
  researcher: ["researcher", "research", "sources", "evidence", "findings", "synthesis"],
  librarian: ["librarian", "docs", "documentation", "readme", "spec", "runbook"],
  oracle: ["oracle", "forecast", "risk", "strategy", "decision", "model"],
  monitor: ["monitor", "monitoring", "alert", "anomaly", "health", "watchdog"],
};

const TASK_ISSUE_PATTERNS = [
  "issue",
  "problem",
  "failed",
  "failure",
  "regression",
  "backlog",
  "bug",
  "retry",
];

function sqlEscape(text: string): string {
  return (text || "").replace(/'/g, "''");
}

function runPsqlQuery(sql: string): string {
  const result = runPsql(sql, {
    db: DB_NAME,
    args: ["-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A"],
    env: withPostgresPath(process.env),
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "psql failed").toString().trim();
    throw new Error(err || "psql failed");
  }
  return (result.stdout || "").toString().trim();
}

function classifyAgent(text: string): string {
  const lowered = (text || "").toLowerCase();
  const hits: Record<string, number> = {};
  for (const [role, words] of Object.entries(AGENT_KEYWORDS)) {
    const score = words.reduce((acc, w) => acc + (lowered.includes(w) ? 1 : 0), 0);
    if (score) hits[role] = score;
  }
  if (!Object.keys(hits).length) return "all";
  return Object.entries(hits).sort((a, b) => b[1] - a[1])[0][0];
}

function normalizeLesson(text: string): string {
  return (text || "").trim().replace(/\s+/g, " ").slice(0, 800);
}

function upsertLesson(params: {
  agentRole: string;
  feedbackText: string;
  confidence: number;
  sourceFeedbackId?: number | null;
  sourceTaskId?: number | null;
}): void {
  const lesson = normalizeLesson(params.feedbackText);
  if (!lesson) return;

  const sourceFeedbackSql = params.sourceFeedbackId == null ? "NULL" : String(params.sourceFeedbackId);
  const sourceTaskSql = params.sourceTaskId == null ? "NULL" : String(params.sourceTaskId);

  const sql = `
INSERT INTO cortana_agent_feedback
  (agent_role, feedback_text, source_feedback_id, source_task_id, confidence, active, updated_at)
VALUES
  ('${sqlEscape(params.agentRole)}', '${sqlEscape(lesson)}', ${sourceFeedbackSql}, ${sourceTaskSql}, ${params.confidence.toFixed(2)}, TRUE, NOW())
ON CONFLICT (agent_role, lower(feedback_text), active) WHERE active = TRUE
DO UPDATE
SET confidence = GREATEST(cortana_agent_feedback.confidence, EXCLUDED.confidence),
    source_feedback_id = COALESCE(EXCLUDED.source_feedback_id, cortana_agent_feedback.source_feedback_id),
    source_task_id = COALESCE(EXCLUDED.source_task_id, cortana_agent_feedback.source_task_id),
    updated_at = NOW();
`;
  runPsqlQuery(sql);
}

function parseRows(raw: string): string[][] {
  const rows: string[][] = [];
  for (const line of (raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(line.split("|"));
  }
  return rows;
}

function compileFromFeedback(): number {
  const sql = `
SELECT id, feedback_type, context, lesson, applied
FROM cortana_feedback
ORDER BY id DESC
LIMIT 300;
`;
  const rows = parseRows(runPsqlQuery(sql));
  let inserted = 0;

  for (const row of rows) {
    const feedbackId = Number(row[0]);
    const feedbackType = row[1] ?? "";
    const context = row[2] ?? "";
    const lesson = row[3] ?? "";
    const applied = (row[4] ?? "").toLowerCase();
    const appliedBool = applied === "t" || applied === "true" || applied === "1";

    if (!lesson) continue;

    const combined = `${feedbackType} ${context} ${lesson}`;
    const role = classifyAgent(combined);
    const confidence = appliedBool ? 0.88 : 0.72;
    upsertLesson({
      agentRole: role,
      feedbackText: lesson,
      confidence,
      sourceFeedbackId: feedbackId,
    });
    inserted += 1;
  }

  return inserted;
}

function compileFromTasks(): number {
  const patternSql = TASK_ISSUE_PATTERNS.map((p) => `COALESCE(outcome,'') ILIKE '%${p}%'`)
    .concat(TASK_ISSUE_PATTERNS.map((p) => `COALESCE(description,'') ILIKE '%${p}%'`))
    .join(" OR ");

  const sql = `
SELECT id, title, description, status, outcome
FROM cortana_tasks
WHERE status = 'failed'
   OR (status = 'completed' AND (${patternSql}))
ORDER BY id DESC
LIMIT 300;
`;

  const rows = parseRows(runPsqlQuery(sql));
  let inserted = 0;

  for (const row of rows) {
    const taskId = Number(row[0]);
    const title = row[1] ?? "";
    const description = row[2] ?? "";
    const status = row[3] ?? "";
    const outcome = row[4] ?? "";

    const combined = `${title} ${description} ${outcome}`;
    const role = classifyAgent(combined);

    let lesson: string;
    let confidence: number;
    if (status === "failed") {
      lesson = `Avoid repeat failure pattern from task '${title}': ${outcome || description || "Investigate root cause before retry."}`;
      confidence = 0.82;
    } else {
      lesson = `For task '${title}', preserve this learning from issues encountered: ${outcome || description}`;
      confidence = 0.76;
    }

    upsertLesson({
      agentRole: role,
      feedbackText: lesson,
      confidence,
      sourceTaskId: taskId,
    });
    inserted += 1;
  }

  return inserted;
}

function cmdCompile(): number {
  const fCount = compileFromFeedback();
  const tCount = compileFromTasks();
  console.log(
    JSON.stringify({ compiled_from_feedback: fCount, compiled_from_tasks: tCount, total: fCount + tCount })
  );
  return 0;
}

function queryLessons(agentRole: string, limit = 5): Array<Record<string, string | number>> {
  const role = sqlEscape(agentRole.toLowerCase());
  const sql = `
SELECT id, agent_role, feedback_text, confidence, created_at
FROM cortana_agent_feedback
WHERE active = TRUE
  AND (agent_role = '${role}' OR agent_role = 'all')
ORDER BY confidence DESC, updated_at DESC
LIMIT ${Math.trunc(limit)};
`;
  const rows = parseRows(runPsqlQuery(sql));
  return rows.map((row) => ({
    id: Number(row[0]),
    agent_role: row[1],
    feedback_text: row[2],
    confidence: Number(row[3]),
    created_at: row[4],
  }));
}

function cmdQuery(agentRole: string, limit: number): number {
  const items = queryLessons(agentRole, limit);
  console.log(JSON.stringify(items, null, 2));
  return 0;
}

function buildInjectionBlock(agentRole: string, limit = 5): string {
  const items = queryLessons(agentRole, limit);
  if (!items.length) {
    return "## Agent Feedback Lessons\n- No active lessons available for this role yet.";
  }

  const lines = [
    "## Agent Feedback Lessons",
    "These are curated lessons from prior corrections and task outcomes. Apply them in this run.",
  ];
  items.forEach((item, idx) => {
    lines.push(`${idx + 1}. ${item.feedback_text} (confidence=${Number(item.confidence).toFixed(2)})`);
  });
  return lines.join("\n");
}

function cmdInject(agentRole: string, limit: number): number {
  compileFromFeedback();
  compileFromTasks();
  console.log(buildInjectionBlock(agentRole, limit));
  return 0;
}

function cmdDeactivate(id: number): number {
  runPsqlQuery(
    `UPDATE cortana_agent_feedback SET active = FALSE, updated_at = NOW() WHERE id = ${Math.trunc(id)};`
  );
  console.log(JSON.stringify({ deactivated: Math.trunc(id) }));
  return 0;
}

function cmdStats(): number {
  const sql = `
SELECT agent_role, COUNT(*)
FROM cortana_agent_feedback
WHERE active = TRUE
GROUP BY agent_role
ORDER BY COUNT(*) DESC, agent_role ASC;
`;
  const rows = parseRows(runPsqlQuery(sql));
  const payload = rows.map((r) => ({ agent_role: r[0], active_lessons: Number(r[1]) }));
  console.log(JSON.stringify(payload, null, 2));
  return 0;
}

function usageError(): never {
  console.error("usage: feedback_compiler.ts {compile|query|inject|deactivate|stats} [args]");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command) usageError();

  if (command === "compile") {
    process.exit(cmdCompile());
  }

  if (command === "query" || command === "inject") {
    const agentRole = args[0];
    if (!agentRole) usageError();
    const limitIdx = args.indexOf("--limit");
    let normalizedLimit = 5;
    if (limitIdx >= 0) {
      const raw = args[limitIdx + 1];
      if (!raw) usageError();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed)) usageError();
      normalizedLimit = parsed;
    }
    process.exit(command === "query" ? cmdQuery(agentRole, normalizedLimit) : cmdInject(agentRole, normalizedLimit));
  }

  if (command === "deactivate") {
    const id = args[0];
    if (!id) usageError();
    const parsed = Number.parseInt(id, 10);
    if (Number.isNaN(parsed)) usageError();
    process.exit(cmdDeactivate(parsed));
  }

  if (command === "stats") {
    process.exit(cmdStats());
  }

  usageError();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
