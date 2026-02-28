#!/usr/bin/env npx tsx

import { spawnSync } from "child_process";
import { randomUUID } from "crypto";

const DB = "cortana";
const PSQL = ["psql", DB, "-v", "ON_ERROR_STOP=1"];

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };

  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\n") {
      pushField();
      pushRow();
    } else if (ch === "\r") {
      // ignore, handled by \n
    } else {
      field += ch;
    }
  }

  pushField();
  pushRow();

  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

function runPsqlCsv(query: string): Array<Record<string, string>> {
  const cmd = [...PSQL, "-c", `COPY (${query}) TO STDOUT WITH CSV HEADER`];
  const out = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (out.status !== 0) {
    throw new Error(out.stderr || out.stdout || "psql failed");
  }
  const raw = out.stdout || "";
  const rows = parseCsv(raw);
  if (!rows.length) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i += 1) {
      obj[headers[i]] = row[i] ?? "";
    }
    return obj;
  });
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

function mapRow(row: Record<string, string>) {
  const ftype = (row.feedback_type || "").trim().toLowerCase();
  const lesson = row.lesson || "";

  let category: string | null = null;
  let severity: string | null = null;

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

  const context = row.context || "";
  const applied = ["t", "true", "1"].includes((row.applied || "").trim().toLowerCase());

  return {
    id: randomUUID(),
    source: "user",
    category,
    severity,
    summary: context.slice(0, 200),
    details: JSON.stringify({ context, lesson }),
    recurrence_key: normalizeRecurrence(lesson),
    status: applied ? "verified" : "new",
    applied,
    lesson,
  };
}

function main(): void {
  const feedbackRows = runPsqlCsv(
    "SELECT id, feedback_type, context, lesson, applied, timestamp FROM cortana_feedback ORDER BY id"
  );

  const existingKeysRows = runPsqlCsv(
    "SELECT recurrence_key FROM mc_feedback_items WHERE recurrence_key IS NOT NULL"
  );

  const existingKeys = new Set<string>();
  for (const row of existingKeysRows) {
    const key = (row.recurrence_key || "").trim();
    if (key) existingKeys.add(key);
  }

  const seenNewKeys = new Set<string>();
  let inserts = 0;
  let skippedDupe = 0;
  let skippedUnmapped = 0;
  let actions = 0;

  const sqlLines: string[] = ["BEGIN;"];

  for (const row of feedbackRows) {
    const mapped = mapRow(row);
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

main();
