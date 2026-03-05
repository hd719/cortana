#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import db from "../lib/db.js";
const { runPsql, withPostgresPath } = db;

type Json = Record<string, any>;

const PSQL_BIN_PATH = "/opt/homebrew/opt/postgresql@17/bin";
const DB_NAME = "cortana";

const EVIDENCE_MARKERS = new Set([
  "implemented",
  "updated",
  "added",
  "fixed",
  "refactored",
  "tested",
  "validated",
  "committed",
  "pushed",
  "created",
  "ran",
  "query",
  "sql",
  "python",
]);

const VAGUE_PATTERNS = [
  /^\s*done\.?\s*$/i,
  /^\s*completed\.?\s*$/i,
  /^\s*all good\.?\s*$/i,
  /^\s*fixed it\.?\s*$/i,
  /^\s*handled\.?\s*$/i,
];

function emit(event: string, payload: Json, pretty = false): void {
  const doc = { event, ts: new Date().toISOString(), ...payload };
  if (pretty) console.log(JSON.stringify(doc, null, 2));
  else console.log(JSON.stringify(doc));
}

function runSql(query: string): string {
  const proc = runPsql(query, { db: DB_NAME, args: ["-X", "-t", "-A"], env: withPostgresPath(process.env) });
  if (proc.status !== 0) {
    const msg = (proc.stderr ?? proc.stdout ?? "psql failed").trim();
    throw new Error(msg || "psql failed");
  }
  return (proc.stdout ?? "").trim();
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function tokenize(label: string): string[] {
  return label
    .toLowerCase()
    .split(/[^a-zA-Z0-9]+/)
    .filter((tok) => tok.length >= 3);
}

function validateResult(result: string): Json {
  const norm = normalize(result);
  const wordCount = norm ? norm.split(" ").length : 0;

  const reasons: string[] = [];
  let score = 1.0;

  if (!norm) {
    reasons.push("empty");
    score -= 1.0;
  }

  if (VAGUE_PATTERNS.some((re) => re.test(norm))) {
    reasons.push("vague_one_liner");
    score -= 0.6;
  }

  if (wordCount < 8) {
    reasons.push("too_short");
    score -= 0.35;
  }

  const evidenceHits = Array.from(EVIDENCE_MARKERS).filter((m) => norm.includes(m)).length;
  const hasPathsOrCommands = /\/\w|\.py\b|\.md\b|git\s+|python3\s+|SELECT\s+|UPDATE\s+/i.test(result);

  if (evidenceHits === 0 && !hasPathsOrCommands) {
    reasons.push("no_evidence_markers");
    score -= 0.5;
  }

  const valid = score >= 0.5 && !reasons.includes("empty");
  return {
    valid,
    score: Math.max(0, Math.round(score * 10000) / 10000),
    reasons,
    word_count: wordCount,
    evidence_hits: evidenceHits,
    has_paths_or_commands: hasPathsOrCommands,
  };
}

function fetchCandidates(label: string): Json[] {
  const tokens = tokenize(label);
  const likeClauses = tokens.map(
    (t) => `LOWER(title) LIKE '%${t}%' OR LOWER(COALESCE(description,'')) LIKE '%${t}%'`
  );
  const tokenFilter = likeClauses.length ? likeClauses.join(" OR ") : "TRUE";

  const query = `
    SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
    FROM (
      SELECT id, title, description, status, assigned_to, priority, created_at
      FROM cortana_tasks
      WHERE status IN ('ready', 'in_progress')
        AND (${tokenFilter}
             OR LOWER(COALESCE(assigned_to,'')) LIKE '%' || ${sqlQuote(label.toLowerCase())} || '%'
             OR LOWER(COALESCE(metadata::text,'')) LIKE '%' || ${sqlQuote(label.toLowerCase())} || '%')
      ORDER BY priority ASC, created_at DESC
      LIMIT 50
    ) t;
  `;

  const raw = runSql(query);
  if (!raw) return [];
  return JSON.parse(raw);
}

function longestCommonSubstring(a: string, b: string): { aIndex: number; bIndex: number; length: number } {
  let maxLen = 0;
  let endA = 0;
  let endB = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prevDiag = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = prev[j];
      if (a[i - 1] === b[j - 1]) {
        prev[j] = prevDiag + 1;
        if (prev[j] > maxLen) {
          maxLen = prev[j];
          endA = i;
          endB = j;
        }
      } else {
        prev[j] = 0;
      }
      prevDiag = temp;
    }
  }
  return { aIndex: endA - maxLen, bIndex: endB - maxLen, length: maxLen };
}

function matchingBlocks(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  const { aIndex, bIndex, length } = longestCommonSubstring(a, b);
  if (length === 0) return 0;
  const left = matchingBlocks(a.slice(0, aIndex), b.slice(0, bIndex));
  const right = matchingBlocks(a.slice(aIndex + length), b.slice(bIndex + length));
  return length + left + right;
}

function sequenceMatcherRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 1.0;
  const matches = matchingBlocks(a, b);
  return (2.0 * matches) / (a.length + b.length);
}

function similarityScore(label: string, task: Json): number {
  const l = normalize(label);
  const title = normalize(String(task.title ?? ""));
  const desc = normalize(String(task.description ?? ""));

  const titleRatio = sequenceMatcherRatio(l, title);
  const descRatio = sequenceMatcherRatio(l, desc);

  const tokenHits = tokenize(label).filter((t) => title.includes(t) || desc.includes(t)).length;
  const tokenBonus = Math.min(0.3, tokenHits * 0.06);

  return Math.max(titleRatio, descRatio * 0.8) + tokenBonus;
}

function summarizeResult(result: string, maxLen = 500): string {
  const cleaned = result.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 3) + "...";
}

function updateTaskDone(taskId: number, summary: string, label: string): Json {
  const query = `
    UPDATE cortana_tasks
    SET status = 'completed',
        completed_at = NOW(),
        outcome = ${sqlQuote(summary)},
        metadata = COALESCE(metadata, '{}'::jsonb) ||
                   jsonb_build_object('auto_sync', true, 'subagent_label', ${sqlQuote(label)})
    WHERE id = ${taskId}
    RETURNING row_to_json(cortana_tasks);
  `;
  const raw = runSql(query);
  if (!raw) throw new Error(`Update failed for task ${taskId}`);
  return JSON.parse(raw);
}

function createDoneTask(label: string, summary: string): Json {
  const title = `Sub-agent completion: ${label}`;
  const query = `
    INSERT INTO cortana_tasks
      (source, title, description, priority, status, auto_executable, outcome, completed_at, metadata, assigned_to)
    VALUES
      ('subagent_auto_sync',
       ${sqlQuote(title)},
       ${sqlQuote("Auto-created from sub-agent completion sync.")},
       3,
       'completed',
       FALSE,
       ${sqlQuote(summary)},
       NOW(),
       jsonb_build_object('auto_sync', true, 'created_from_label', ${sqlQuote(label)}),
       ${sqlQuote(label)})
    RETURNING row_to_json(cortana_tasks);
  `;
  const raw = runSql(query);
  if (!raw) throw new Error("Insert failed for fallback completed task");
  return JSON.parse(raw);
}

type Args = {
  label: string | null;
  result: string | null;
  resultFile: string | null;
  minMatch: number;
  pretty: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = { label: null, result: null, resultFile: null, minMatch: 0.38, pretty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--label":
        args.label = argv[i + 1] ?? null;
        i += 1;
        break;
      case "--result":
        args.result = argv[i + 1] ?? null;
        i += 1;
        break;
      case "--result-file":
        args.resultFile = argv[i + 1] ?? null;
        i += 1;
        break;
      case "--min-match":
        args.minMatch = Number(argv[i + 1]);
        i += 1;
        break;
      case "--pretty":
        args.pretty = true;
        break;
      default:
        break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.label || (!args.result && !args.resultFile) || (args.result && args.resultFile)) {
    console.error("usage: auto_sync_enforcer.ts --label <label> (--result <text> | --result-file <path>)");
    process.exit(2);
  }

  const resultText = args.result ?? fs.readFileSync(path.resolve(args.resultFile!), "utf8");
  const validation = validateResult(resultText);
  emit("auto_sync_validation", { label: args.label, ...validation }, args.pretty);

  if (!validation.valid) {
    emit(
      "auto_sync_rejected",
      { label: args.label, reason: "Completion result failed validation", validation },
      args.pretty
    );
    process.exit(3);
  }

  const candidates = fetchCandidates(args.label);
  const scored = candidates.map((task) => ({ task, score: Math.round(similarityScore(args.label!, task) * 10000) / 10000 }));
  scored.sort((a, b) => b.score - a.score);

  emit(
    "auto_sync_match_scan",
    {
      label: args.label,
      candidate_count: scored.length,
      top_candidates: scored.slice(0, 5).map((c) => ({ id: c.task.id, title: c.task.title, score: c.score })),
    },
    args.pretty
  );

  const summary = summarizeResult(resultText);
  try {
    if (scored.length && scored[0].score >= args.minMatch) {
      const chosen = scored[0].task;
      const updated = updateTaskDone(Number(chosen.id), summary, args.label);
      emit(
        "auto_sync_task_updated",
        { label: args.label, matched_task_id: chosen.id, match_score: scored[0].score, status: "completed", task: updated },
        args.pretty
      );
    } else {
      const created = createDoneTask(args.label, summary);
      emit(
        "auto_sync_task_created",
        { label: args.label, reason: "no_match_found", status: "completed", task: created },
        args.pretty
      );
    }
  } catch (err) {
    emit("auto_sync_error", { label: args.label, error: err instanceof Error ? err.message : String(err) }, args.pretty);
    process.exit(2);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
