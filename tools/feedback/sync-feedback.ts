#!/usr/bin/env npx tsx

import { spawnSync } from "child_process";
import { randomUUID } from "crypto";

const DB = "cortana";
const PSQL = ["psql", DB, "-v", "ON_ERROR_STOP=1"];

type Row = Record<string, string>;

type MappedRow = {
  id: string;
  source: string;
  category: string;
  severity: string;
  summary: string;
  details: string;
  recurrence_key: string;
  status: string;
  applied: boolean;
  lesson: string;
};

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }

    if (ch === "\r") {
      continue;
    }

    field += ch;
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function parseCsvWithHeader(text: string): Row[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0];
  const out: Row[] = [];
  for (const row of rows.slice(1)) {
    if (row.length === 1 && row[0] === "") continue;
    const obj: Row = {};
    for (let i = 0; i < header.length; i += 1) {
      obj[header[i]] = row[i] ?? "";
    }
    out.push(obj);
  }
  return out;
}

function runPsqlCsv(query: string): Row[] {
  const cmd = [...PSQL, "-c", `COPY (${query}) TO STDOUT WITH CSV HEADER`];
  const out = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (out.status !== 0) {
    throw new Error(out.stderr || out.stdout || "psql failed");
  }
  return parseCsvWithHeader(out.stdout || "");
}

function runSql(sql: string): void {
  const proc = spawnSync(PSQL[0], PSQL.slice(1), { input: sql, encoding: "utf8" });
  if (proc.status !== 0) {
    throw new Error(proc.stderr || proc.stdout || "psql failed");
  }
}

function q(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeRecurrence(lesson: string): string {
  if (!lesson) return "";
  let s = lesson.toLowerCase().trim();
  s = s.replace(/\s+/g, " ");
  s = s.replace(/[^a-z0-9 ]/g, "");
  return s.slice(0, 50).trim();
}

function mapRow(row: Row): MappedRow | null {
  const ftype = String(row.feedback_type ?? "").trim().toLowerCase();
  const lesson = row.lesson ?? "";

  let category: string;
  let severity: string;
  if (ftype === "correction") {
    category = "correction";
    severity = /HARD RULE|MANDATORY|ZERO TOLERANCE/i.test(lesson) ? "high" : "medium";
  } else if (ftype === "preference") {
    category = "preference";
    severity = "low";
  } else if (ftype === "approval") {
    category = "policy";
    severity = "low";
  } else if (ftype === "rejection") {
    category = "policy";
    severity = "medium";
  } else {
    return null;
  }

  const context = row.context ?? "";
  const applied = String(row.applied ?? "").trim().toLowerCase();
  const appliedFlag = ["t", "true", "1"].includes(applied);

  return {
    id: randomUUID(),
    source: "user",
    category,
    severity,
    summary: context.slice(0, 200),
    details: JSON.stringify({ context, lesson }),
    recurrence_key: normalizeRecurrence(lesson),
    status: appliedFlag ? "verified" : "new",
    applied: appliedFlag,
    lesson,
  };
}

function printHelp(): void {
  const text = `usage: sync-feedback.ts [-h]\n\noptions:\n  -h, --help  show this help message and exit`;
  console.log(text);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    return;
  }

  const feedbackRows = runPsqlCsv(
    "SELECT id, feedback_type, context, lesson, applied, timestamp FROM cortana_feedback ORDER BY id"
  );

  const existingKeysRows = runPsqlCsv(
    "SELECT recurrence_key FROM mc_feedback_items WHERE recurrence_key IS NOT NULL"
  );
  const existingKeys = new Set(
    existingKeysRows
      .map((r) => (r.recurrence_key ?? "").trim())
      .filter((k) => k)
  );

  const seenNewKeys = new Set<string>();
  let inserts = 0;
  let skippedDupe = 0;
  let skippedUnmapped = 0;
  let actions = 0;

  const sqlLines: string[] = ["BEGIN;"];

  for (const r of feedbackRows) {
    const mapped = mapRow(r);
    if (!mapped) {
      skippedUnmapped += 1;
      continue;
    }

    const rk = mapped.recurrence_key;
    if (rk && (existingKeys.has(rk) || seenNewKeys.has(rk))) {
      skippedDupe += 1;
      continue;
    }

    sqlLines.push(
      "INSERT INTO mc_feedback_items (id, source, category, severity, summary, details, recurrence_key, status) " +
        `VALUES (${q(mapped.id)}::uuid, ${q(mapped.source)}, ${q(mapped.category)}, ${q(mapped.severity)}, ` +
        `${q(mapped.summary)}, ${q(mapped.details)}::jsonb, ${q(rk)}, ${q(mapped.status)});`
    );
    inserts += 1;
    if (rk) seenNewKeys.add(rk);

    if (mapped.applied) {
      sqlLines.push(
        "INSERT INTO mc_feedback_actions (feedback_id, action_type, description, status) " +
          `VALUES (${q(mapped.id)}::uuid, 'policy_rule', ${q(mapped.lesson)}, 'verified');`
      );
      actions += 1;
    }
  }

  sqlLines.push("COMMIT;");
  runSql(sqlLines.join("\n"));

  console.log("Feedback migration complete");
  console.log(`- Source rows read: ${feedbackRows.length}`);
  console.log(`- Items inserted: ${inserts}`);
  console.log(`- Actions inserted: ${actions}`);
  console.log(`- Skipped duplicates (recurrence_key): ${skippedDupe}`);
  console.log(`- Skipped unmapped feedback_type: ${skippedUnmapped}`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
