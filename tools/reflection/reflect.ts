#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { resolveRepoPath } from "../lib/paths.js";
import { query } from "../lib/db.js";

const ROOT = resolveRepoPath();

const TARGET_FILES: Record<string, string> = {
  preference: path.join(ROOT, "MEMORY.md"),
  fact: path.join(ROOT, "MEMORY.md"),
  behavior: path.join(ROOT, "AGENTS.md"),
  tone: path.join(ROOT, "SOUL.md"),
  correction: path.join(ROOT, "AGENTS.md"),
};

const FAILURE_HINTS = ["fail", "error", "broken", "backlog", "retry", "regress", "didn't", "did not"];
const NEAR_MISS_HINTS = ["almost", "near", "manual", "had to", "would have", "close call"];

type ReflectionRule = {
  feedback_type: string;
  rule_text: string;
  evidence_count: number;
  first_seen: string;
  last_seen: string;
  confidence: number;
};

function sqlEscape(text: string): string {
  return text.replace(/'/g, "''");
}

function runPsql(sql: string): string {
  return query(sql).trim();
}

function fetchJson(sql: string): Array<Record<string, any>> {
  const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (${sql}) t;`;
  const raw = runPsql(wrapped);
  return raw ? (JSON.parse(raw) as Array<Record<string, any>>) : [];
}

function writeJournal(
  runId: number,
  entryType: string,
  title: string,
  body = "",
  metadata: Record<string, unknown> | null = null
): void {
  const meta = JSON.stringify(metadata ?? {});
  runPsql(
    "INSERT INTO cortana_reflection_journal (run_id, entry_type, title, body, metadata) " +
      `VALUES (${runId}, '${sqlEscape(entryType)}', '${sqlEscape(title)}', '${sqlEscape(body)}', '${sqlEscape(meta)}'::jsonb);`
  );
}

function startRun(triggerSource: string, mode: string, windowDays: number): number {
  const rid = runPsql(
    "INSERT INTO cortana_reflection_runs (trigger_source, mode, window_days) " +
      `VALUES ('${sqlEscape(triggerSource)}', '${sqlEscape(mode)}', ${windowDays}) RETURNING id;`
  );
  return Number.parseInt(rid, 10);
}

function classifyTask(task: Record<string, any>): [string, number, string] {
  const text = `${task.title ?? ""} ${task.description ?? ""} ${task.outcome ?? ""}`.toLowerCase();
  if (FAILURE_HINTS.some((h) => text.includes(h))) {
    return ["failure", 0.9, "Task outcome contains failure indicators."];
  }
  if (NEAR_MISS_HINTS.some((h) => text.includes(h))) {
    return ["near_miss", 0.7, "Task outcome indicates near-miss/manual recovery."];
  }
  if (String(task.status ?? "") === "completed") {
    return ["success", 0.4, "Task completed without explicit failure markers."];
  }
  return ["unknown", 0.2, "Insufficient outcome signal."];
}

function taskReflection(runId: number, explicitTaskId: number | null): number {
  const where = explicitTaskId
    ? `t.id = ${explicitTaskId}`
    : "t.status IN ('completed','cancelled') AND t.completed_at > NOW() - INTERVAL '7 days'";

  const tasks = fetchJson(
    "SELECT t.id, t.title, t.description, t.status, t.outcome, t.completed_at " +
      "FROM cortana_tasks t " +
      "LEFT JOIN cortana_task_reflections r ON r.task_id = t.id " +
      `WHERE ${where} AND r.task_id IS NULL ` +
      "ORDER BY t.completed_at DESC NULLS LAST LIMIT 100"
  );

  let reflected = 0;
  for (const task of tasks) {
    const [outcomeType, signal, reason] = classifyTask(task);
    const lesson = `${reason} Lesson: reinforce planning + validation around '${task.title ?? "task"}'.`;
    const evidence = JSON.stringify({
      status: task.status,
      outcome: task.outcome,
      completed_at: task.completed_at,
    });

    runPsql(
      "INSERT INTO cortana_task_reflections (task_id, outcome_type, signal_score, lesson, evidence) VALUES " +
        `(${Number(task.id)}, '${outcomeType}', ${signal.toFixed(2)}, '${sqlEscape(lesson)}', '${sqlEscape(evidence)}'::jsonb)` +
        " ON CONFLICT (task_id) DO NOTHING;"
    );

    if (outcomeType === "failure" || outcomeType === "near_miss") {
      writeJournal(runId, "task_reflection", `Task #${task.id} reflected as ${outcomeType}`, lesson, {
        task_id: task.id,
        signal_score: signal,
      });
    }
    reflected += 1;
  }

  return reflected;
}

function normalizeRuleText(lesson: string): string {
  return lesson.replace(/\s+/g, " ").trim().slice(0, 400);
}

function extractRules(windowDays: number): [ReflectionRule[], number, number] {
  const rows = fetchJson(
    "SELECT feedback_type, lesson, COUNT(*)::int AS evidence_count, " +
      "MIN(timestamp) AS first_seen, MAX(timestamp) AS last_seen " +
      "FROM cortana_feedback " +
      `WHERE timestamp > NOW() - INTERVAL '${windowDays} days' ` +
      "GROUP BY feedback_type, lesson ORDER BY evidence_count DESC, last_seen DESC"
  );

  const totalFeedback = rows.reduce((sum, r) => sum + Number(r.evidence_count ?? 0), 0) || 1;
  const repeats = rows.reduce((sum, r) => sum + Math.max(0, Number(r.evidence_count ?? 0) - 1), 0);
  const repeatedRate = Math.round((repeats / totalFeedback) * 10000) / 100;

  const rules: ReflectionRule[] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const r of rows) {
    const n = Number(r.evidence_count ?? 0);
    const lastSeen = String(r.last_seen ?? "");
    const recencyBonus = lastSeen.startsWith(today) ? 0.15 : 0.05;
    const confidence = Math.min(0.98, 0.35 + 0.22 * Math.log(n + 1) + recencyBonus);
    rules.push({
      feedback_type: String(r.feedback_type ?? ""),
      rule_text: normalizeRuleText(String(r.lesson ?? "")),
      evidence_count: n,
      first_seen: String(r.first_seen ?? ""),
      last_seen: lastSeen,
      confidence: Math.round(confidence * 1000) / 1000,
    });
  }

  return [rules, repeatedRate, totalFeedback];
}

function ensureManagedSection(filePath: string): string {
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const start = "<!-- AUTO_REFLECTION_RULES:START -->";
  const end = "<!-- AUTO_REFLECTION_RULES:END -->";
  if (text.includes(start) && text.includes(end)) return text;

  const block =
    "\n\n## Auto-Reflected Rules\n" +
    `${start}\n` +
    "- (managed by tools/reflection/reflect.py)\n" +
    `${end}\n`;

  return text + block;
}

function applyRuleToFile(filePath: string, rule: ReflectionRule): void {
  const text = ensureManagedSection(filePath);
  const start = "<!-- AUTO_REFLECTION_RULES:START -->";
  const end = "<!-- AUTO_REFLECTION_RULES:END -->";
  const entry = `- [${rule.feedback_type}] ${rule.rule_text} (conf=${rule.confidence.toFixed(3)}, n=${rule.evidence_count})`;

  const [pre, rest] = text.split(start, 2);
  const [body, post] = rest.split(end, 2);
  const lines = body
    .trim()
    .split(/\r?\n/)
    .map((ln) => ln.trimEnd())
    .filter((ln) => ln.trim());

  if (!lines.includes(entry)) {
    lines.push(entry);
  }

  const newBody = "\n" + lines.join("\n") + "\n";
  fs.writeFileSync(filePath, pre + start + newBody + end + post, "utf8");
}

function upsertRules(runId: number, rules: ReflectionRule[], autoThreshold: number): number {
  let applied = 0;
  for (const rule of rules) {
    const target = TARGET_FILES[rule.feedback_type] ?? path.join(ROOT, "AGENTS.md");
    const meta = JSON.stringify({ first_seen: rule.first_seen, last_seen: rule.last_seen });

    runPsql(
      "INSERT INTO cortana_reflection_rules (feedback_type, rule_text, confidence, evidence_count, first_seen, last_seen, status, target_file, source_run_id, metadata) " +
        `VALUES ('${sqlEscape(rule.feedback_type)}', '${sqlEscape(rule.rule_text)}', ${rule.confidence}, ${rule.evidence_count}, ` +
        `'${sqlEscape(rule.first_seen)}', '${sqlEscape(rule.last_seen)}', 'proposed', '${sqlEscape(target)}', ${runId}, '${sqlEscape(meta)}'::jsonb) ` +
        "ON CONFLICT (feedback_type, rule_text) DO UPDATE SET " +
        "confidence = EXCLUDED.confidence, evidence_count = EXCLUDED.evidence_count, last_seen = EXCLUDED.last_seen, source_run_id = EXCLUDED.source_run_id;"
    );

    if (rule.confidence >= autoThreshold && rule.evidence_count >= 2) {
      applyRuleToFile(target, rule);
      runPsql(
        "UPDATE cortana_reflection_rules SET status='applied', applied_at=NOW() " +
          `WHERE feedback_type='${sqlEscape(rule.feedback_type)}' AND rule_text='${sqlEscape(rule.rule_text)}';`
      );
      applied += 1;
    }
  }
  return applied;
}

function run(triggerSource: string, mode: string, windowDays: number, taskId: number | null, autoThreshold: number): void {
  const runId = startRun(triggerSource, mode, windowDays);
  try {
    const reflectedTasks = taskReflection(runId, taskId);
    const [rules, repeatedRate, feedbackRows] = extractRules(windowDays);
    const autoApplied = upsertRules(runId, rules, autoThreshold);

    writeJournal(
      runId,
      "kpi",
      "Repeated correction rate",
      `${repeatedRate.toFixed(2)}% over last ${windowDays} days`,
      { window_days: windowDays, feedback_rows: feedbackRows }
    );

    runPsql(
      "UPDATE cortana_reflection_runs SET " +
        `completed_at=NOW(), status='completed', feedback_rows=${feedbackRows}, reflected_tasks=${reflectedTasks}, ` +
        `rules_extracted=${rules.length}, rules_auto_applied=${autoApplied}, repeated_correction_rate=${repeatedRate}, ` +
        `summary='${sqlEscape(`Processed ${feedbackRows} feedback rows, extracted ${rules.length} rules, auto-applied ${autoApplied}.`)}' ` +
        `WHERE id=${runId};`
    );

    console.log(
      JSON.stringify({
        run_id: runId,
        status: "completed",
        reflected_tasks: reflectedTasks,
        feedback_rows: feedbackRows,
        rules_extracted: rules.length,
        rules_auto_applied: autoApplied,
        repeated_correction_rate: repeatedRate,
      })
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    writeJournal(runId, "error", "Reflection run failed", msg, {});
    runPsql(
      "UPDATE cortana_reflection_runs SET completed_at=NOW(), status='failed', " +
        `error='${sqlEscape(msg)}' WHERE id=${runId};`
    );
    throw error;
  }
}

function printHelp(): void {
  const text = `usage: reflect.ts [-h] [--mode {sweep,task}] [--trigger-source {manual,heartbeat,post_task,cron}] [--window-days WINDOW_DAYS] [--task-id TASK_ID] [--auto-apply-threshold AUTO_APPLY_THRESHOLD]\n\nCortana reflection loop\n\noptions:\n  -h, --help            show this help message and exit\n  --mode {sweep,task}\n  --trigger-source {manual,heartbeat,post_task,cron}\n  --window-days WINDOW_DAYS\n  --task-id TASK_ID\n  --auto-apply-threshold AUTO_APPLY_THRESHOLD`;
  console.log(text);
}

type Args = {
  mode: string;
  triggerSource: string;
  windowDays: number;
  taskId: number | null;
  autoApplyThreshold: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    mode: "sweep",
    triggerSource: "manual",
    windowDays: 30,
    taskId: null,
    autoApplyThreshold: 0.82,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else if (arg === "--mode" && next) {
      args.mode = next;
      i += 1;
    } else if (arg === "--trigger-source" && next) {
      args.triggerSource = next;
      i += 1;
    } else if (arg === "--window-days" && next) {
      args.windowDays = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--task-id" && next) {
      args.taskId = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--auto-apply-threshold" && next) {
      args.autoApplyThreshold = Number.parseFloat(next);
      i += 1;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "task" && !args.taskId) {
    console.error("--task-id is required for --mode task");
    process.exit(2);
  }

  try {
    run(args.triggerSource, args.mode, args.windowDays, args.taskId, args.autoApplyThreshold);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(msg);
    process.exit(1);
  }
}

main();
