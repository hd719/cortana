#!/usr/bin/env npx tsx

/** Agent Output Quality Scorecards. */

import fs from "fs";
import { spawnSync } from "child_process";
import { runPsql, withPostgresPath } from "../lib/db.js";

const CRITERIA_POINTS = 20;

const ROLE_KEYWORDS: Record<string, string[]> = {
  huragok: ["infra", "migration", "build", "tool", "automation", "service", "devops"],
  researcher: ["research", "compare", "analysis", "findings", "sources"],
  librarian: ["docs", "documentation", "readme", "runbook", "guide"],
  oracle: ["forecast", "risk", "strategy", "decision", "model"],
  monitor: ["monitor", "alert", "health", "watch", "scorecard", "quality"],
};

type Json = Record<string, any>;

function sqlEscape(text: string): string {
  return (text || "").replace(/'/g, "''");
}

function runPsqlQuery(sql: string): string {
  const result = runPsql(sql, {
    db: "cortana",
    args: ["-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "|"],
    env: withPostgresPath(process.env),
  });
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "psql failed").toString().trim();
    throw new Error(err || "psql failed");
  }
  return (result.stdout || "").toString().trim();
}

function runGit(args: string[]): string {
  const out = spawnSync("git", args, { encoding: "utf8" });
  if (out.status !== 0) {
    const msg = (out.stderr || out.stdout || `git ${args.join(" ")} failed`).toString().trim();
    throw new Error(msg || `git ${args.join(" ")} failed`);
  }
  return (out.stdout || "").toString().trim();
}

function parseRow(raw: string): string[] {
  const line = (raw || "")
    .split(/\r?\n/)
    .find((ln) => ln.trim()) || "";
  return line ? line.split("|") : [];
}

function inferAgentRole(...texts: string[]): string {
  const blob = texts.filter((t) => t).join(" ").toLowerCase();
  if (!blob) return "unknown";
  const scores: Record<string, number> = {};
  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    const hit = keywords.filter((kw) => blob.includes(kw)).length;
    if (hit) scores[role] = hit;
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : "unknown";
}

function getTask(taskId: number): Json {
  const sql = `
SELECT id, status, title, description, execution_plan, COALESCE(outcome,''), COALESCE(assigned_to,''), COALESCE(metadata::text,'{}')
FROM cortana_tasks
WHERE id = ${Math.trunc(taskId)};
`;
  const row = parseRow(runPsqlQuery(sql));
  if (!row.length) {
    throw new Error(`Task ${taskId} not found`);
  }

  let metadata: Json = {};
  try {
    metadata = row[7] ? JSON.parse(row[7]) : {};
  } catch {
    metadata = {};
  }

  return {
    id: Number(row[0]),
    status: row[1],
    title: row[2],
    description: row[3],
    execution_plan: row[4],
    outcome: row[5],
    assigned_to: row[6],
    metadata,
  };
}

function titleTokens(title: string): string[] {
  const tokens = (title || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.filter((t) => t.length >= 5);
}

function relatedCommitHashes(taskId: number, title: string, maxCommits = 300): string[] {
  const log = runGit(["log", `-n${maxCommits}`, "--pretty=format:%H|%s|%b"]);
  const hashes: string[] = [];
  const titleWords = titleTokens(title);

  for (const line of log.split(/\r?\n/)) {
    const parts = line.split("|", 3);
    if (parts.length < 2) continue;
    const commitHash = parts[0];
    const msg = [parts[1], parts[2] || ""].join(" ").toLowerCase();

    const explicit = [
      `task ${taskId}`,
      `task#${taskId}`,
      `#${taskId}`,
      `id ${taskId}`,
      `id:${taskId}`,
    ].some((token) => msg.includes(token));

    const titleHits = titleWords.filter((token) => msg.includes(token)).length;

    if (explicit || titleHits >= 2) hashes.push(commitHash);
  }

  return hashes;
}

function changedFilesForCommits(commits: string[]): string[] {
  if (!commits.length) return [];
  const files: string[] = [];
  for (const commit of commits) {
    const out = runGit(["show", "--name-only", "--pretty=format:", commit]);
    for (const line of out.split(/\r?\n/)) {
      if (line.trim()) files.push(line.trim());
    }
  }
  return Array.from(new Set(files)).sort();
}

function compilePythonFiles(files: string[]): [boolean, string[], string] {
  const pyFiles = files.filter((f) => f.endsWith(".py") && fs.existsSync(f));
  if (!pyFiles.length) {
    return [true, [], "No Python files changed in related commits."];
  }

  const failed: string[] = [];
  let lastError = "";
  for (const pyf of pyFiles) {
    const out = spawnSync("python3", ["-m", "py_compile", pyf], { encoding: "utf8" });
    if (out.status !== 0) {
      failed.push(pyf);
      lastError = (out.stderr || out.stdout || "").toString().trim();
    }
  }

  if (failed.length) return [false, failed, lastError];
  return [true, pyFiles, "All changed Python files compile."];
}

function score(taskId: number): Json {
  const task = getTask(taskId);
  const commits = relatedCommitHashes(taskId, task.title);
  const changedFiles = changedFilesForCommits(commits);

  const docsRequired = /\b(doc|docs|documentation|readme|runbook|guide)\b/i.test(
    String(task.execution_plan || "")
  );
  const docsPresent = changedFiles.some(
    (p) => p.startsWith("docs/") || p.toLowerCase().endsWith(".md")
  );

  const [compileOk, compileTargetsOrFailed, compileDetails] = compilePythonFiles(changedFiles);

  const commitsPreview = `[${commits
    .slice(0, 5)
    .map((c) => `'${c}'`)
    .join(", ")}]`;

  const criteria: Json = {
    task_marked_done: {
      passed: task.status === "completed",
      points: task.status === "completed" ? CRITERIA_POINTS : 0,
      details: `status=${task.status}`,
    },
    git_commit_made: {
      passed: commits.length > 0,
      points: commits.length ? CRITERIA_POINTS : 0,
      details: `commits=${commitsPreview}`,
    },
    docs_created_if_required: {
      passed: !docsRequired || docsPresent,
      points: !docsRequired || docsPresent ? CRITERIA_POINTS : 0,
      details: `docs_required=${docsRequired}, docs_present=${docsPresent}`,
    },
    python_compile_check: {
      passed: compileOk,
      points: compileOk ? CRITERIA_POINTS : 0,
      details: compileDetails,
      targets: compileTargetsOrFailed,
    },
    outcome_populated: {
      passed: Boolean(String(task.outcome || "").trim()),
      points: String(task.outcome || "").trim() ? CRITERIA_POINTS : 0,
      details: String(task.outcome || "").trim() ? "outcome present" : "outcome empty",
    },
  };

  const total = Object.values(criteria).reduce((sum, item) => sum + Number(item.points || 0), 0);
  const agentRole = task.assigned_to || inferAgentRole(task.title, task.description, task.execution_plan, task.outcome);

  const insertSql = `
INSERT INTO cortana_quality_scores (task_id, agent_role, score, criteria_results, scored_at)
VALUES (
  ${Math.trunc(taskId)},
  '${sqlEscape(agentRole)}',
  ${total},
  '${sqlEscape(JSON.stringify(criteria))}'::jsonb,
  NOW()
)
RETURNING id, scored_at;
`;
  const stored = parseRow(runPsqlQuery(insertSql));

  return {
    task_id: taskId,
    agent_role: agentRole,
    score: total,
    criteria_results: criteria,
    commits_considered: commits,
    changed_files: changedFiles,
    record_id: stored.length ? Number(stored[0]) : null,
    scored_at: stored.length > 1 ? stored[1] : null,
  };
}

function periodToInterval(period: string): string {
  const match = period.trim().match(/^(\d+)([smhdw])$/);
  if (!match) throw new Error("Invalid period format. Use like 7d, 24h, 30m.");
  const count = Number(match[1]);
  const unitMap: Record<string, string> = {
    s: "seconds",
    m: "minutes",
    h: "hours",
    d: "days",
    w: "weeks",
  };
  return `${count} ${unitMap[match[2]]}`;
}

function report(period = "7d"): Json {
  const interval = periodToInterval(period);
  const sql = `
SELECT
  agent_role,
  COUNT(*) AS samples,
  ROUND(AVG(score)::numeric, 2) AS avg_score,
  MIN(score) AS min_score,
  MAX(score) AS max_score
FROM cortana_quality_scores
WHERE scored_at >= NOW() - INTERVAL '${sqlEscape(interval)}'
GROUP BY agent_role
ORDER BY avg_score DESC, samples DESC;
`;
  const raw = runPsqlQuery(sql);
  const rows: Json[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [role, samples, avgScore, minScore, maxScore] = line.split("|");
    rows.push({
      agent_role: role,
      samples: Number(samples),
      avg_score: Number(avgScore),
      min_score: Number(minScore),
      max_score: Number(maxScore),
    });
  }
  return { period, results: rows };
}

function trends(period = "7d"): Json {
  const interval = periodToInterval(period);
  const sql = `
WITH recent AS (
  SELECT agent_role, AVG(score) AS avg_score, COUNT(*) AS samples
  FROM cortana_quality_scores
  WHERE scored_at >= NOW() - INTERVAL '${sqlEscape(interval)}'
  GROUP BY agent_role
),
previous AS (
  SELECT agent_role, AVG(score) AS avg_score, COUNT(*) AS samples
  FROM cortana_quality_scores
  WHERE scored_at >= NOW() - (INTERVAL '${sqlEscape(interval)}' * 2)
    AND scored_at < NOW() - INTERVAL '${sqlEscape(interval)}'
  GROUP BY agent_role
)
SELECT
  COALESCE(r.agent_role, p.agent_role) AS agent_role,
  COALESCE(r.avg_score, 0) AS recent_avg,
  COALESCE(p.avg_score, 0) AS previous_avg,
  COALESCE(r.samples, 0) AS recent_samples,
  COALESCE(p.samples, 0) AS previous_samples,
  (COALESCE(r.avg_score, 0) - COALESCE(p.avg_score, 0)) AS delta
FROM recent r
FULL OUTER JOIN previous p ON p.agent_role = r.agent_role
ORDER BY delta DESC;
`;
  const raw = runPsqlQuery(sql);
  const rows: Json[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [role, recentAvg, previousAvg, recentSamples, previousSamples, delta] = line.split("|");
    const deltaNum = Number(delta);
    rows.push({
      agent_role: role,
      recent_avg: Number(Number(recentAvg).toFixed(2)),
      previous_avg: Number(Number(previousAvg).toFixed(2)),
      recent_samples: Number(recentSamples),
      previous_samples: Number(previousSamples),
      delta: Number(deltaNum.toFixed(2)),
      trend: deltaNum > 0 ? "improving" : deltaNum < 0 ? "declining" : "flat",
    });
  }

  const generatedAt = new Date().toISOString().replace("Z", "+00:00");
  return { period, generated_at: generatedAt, results: rows };
}

function usageError(): never {
  console.error("usage: quality_scorecard.py score <task_id> | report [--period 7d] | trends [--period 7d]");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  if (!cmd) usageError();

  if (cmd === "score") {
    const taskId = args[0];
    if (!taskId) usageError();
    console.log(JSON.stringify(score(Number(taskId)), null, 2));
    return;
  }

  const periodIdx = args.indexOf("--period");
  const period = periodIdx >= 0 ? args[periodIdx + 1] : "7d";

  if (cmd === "report") {
    console.log(JSON.stringify(report(period), null, 2));
    return;
  }
  if (cmd === "trends") {
    console.log(JSON.stringify(trends(period), null, 2));
    return;
  }

  usageError();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
