#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { resolveHomePath, PSQL_BIN } from "../tools/lib/paths.js";
import { writeJsonFileAtomic } from "../tools/lib/json-file.js";

const SESSION_DIR = resolveHomePath(".openclaw", "agents", "main", "sessions");
const OUTPUT_PATH = "/tmp/efficiency_analysis.json";
const COST_PER_KB = 0.015;
const TOP_N = 5;

function roundMoney(value: number): number {
  return Math.round((value + 1e-12) * 10000) / 10000;
}

function safeReadFirstLine(filePath: string): string {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(4096);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const slice = buffer.slice(0, bytes).toString("utf8");
      const line = slice.split(/\r?\n/)[0] ?? "";
      return line.trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function extractLabelFromFirstLine(line: string): string | null {
  if (!line) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }

  const candidates: Array<unknown> = [];
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    const dict = obj as Record<string, unknown>;
    candidates.push(dict.label, dict.sessionLabel, dict.name, dict.title);
    const meta = dict.metadata;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const md = meta as Record<string, unknown>;
      candidates.push(md.label, md.sessionLabel, md.cronLabel, md.jobName);
    }
  }

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function extractLabelFromFilename(name: string): string {
  const stem = name.endsWith(".jsonl") ? name.slice(0, -6) : name;

  const patterns = [/cron[-_](.+)$/i, /job[-_](.+)$/i, /scheduled[-_](.+)$/i];
  for (const pattern of patterns) {
    const match = stem.match(pattern);
    if (match?.[1]) {
      const label = match[1].replace(/[_-]+/g, " ").trim();
      return label ? label.slice(0, 120) : "unknown";
    }
  }

  let cleaned = stem.replace(/\b[0-9a-f]{8,}\b/gi, "");
  cleaned = cleaned.replace(/\b\d{4,}\b/g, "");
  cleaned = cleaned.replace(/[_-]+/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 120) : "unknown";
}

function isSubagentFile(filePath: string, firstLine: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  if (name.includes("subagent")) return true;
  if (/agent:main:subagent/i.test(firstLine)) return true;
  if (/"session"\s*:\s*"[^"]*subagent/i.test(firstLine)) return true;
  if (/"label"\s*:\s*"[^"]*subagent/i.test(firstLine)) return true;
  return false;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function analyzeSessions(): [Array<Record<string, unknown>>, number, number, string[]] {
  const now = Date.now();
  const cutoff = now - 7 * 24 * 60 * 60 * 1000;

  const costByLabel = new Map<string, number>();
  const kbByLabel = new Map<string, number>();

  let subagentCost = 0;
  let subagentCount = 0;
  let totalCronCost = 0;

  if (!fs.existsSync(SESSION_DIR) || !fs.statSync(SESSION_DIR).isDirectory()) {
    return [[], 0, 0, [`session directory missing: ${SESSION_DIR}`]];
  }

  let files: string[] = [];
  try {
    files = walkFiles(SESSION_DIR).filter((file) => file.endsWith(".jsonl"));
  } catch (error) {
    return [[], 0, 0, [`failed scanning session directory: ${error}`]];
  }

  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (stat.mtimeMs < cutoff) continue;
      const sizeKb = stat.size / 1024;
      const cost = sizeKb * COST_PER_KB;
      const firstLine = safeReadFirstLine(file);

      if (isSubagentFile(file, firstLine)) {
        subagentCount += 1;
        subagentCost += cost;
        continue;
      }

      const label = extractLabelFromFirstLine(firstLine) ?? extractLabelFromFilename(path.basename(file));
      kbByLabel.set(label, (kbByLabel.get(label) ?? 0) + sizeKb);
      costByLabel.set(label, (costByLabel.get(label) ?? 0) + cost);
      totalCronCost += cost;
    } catch {
      continue;
    }
  }

  const top = [...costByLabel.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N);

  const topCostCrons = top.map(([name, cost]) => ({
    name,
    size_kb: Math.round((kbByLabel.get(name) ?? 0) * 100) / 100,
    est_cost: roundMoney(cost),
  }));

  const anomalies: string[] = [];
  if (totalCronCost > 0) {
    const sorted = [...costByLabel.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, cost] of sorted) {
      const share = cost / totalCronCost;
      if (share > 0.3) {
        anomalies.push(`cron '${name}' is ${(share * 100).toFixed(1)}% of weekly cron spend`);
      }
    }
  }

  return [topCostCrons, roundMoney(subagentCost), subagentCount, anomalies];
}

function runPsql(sql: string): [boolean, string] {
  const result = spawnSync(PSQL_BIN, ["cortana", "-t", "-A", "-c", sql], {
    encoding: "utf8",
    timeout: 3000,
  });

  if (result.error) {
    return [false, result.error.message];
  }

  if (result.status !== 0) {
    return [false, (result.stderr || result.stdout || "").trim()];
  }

  return [true, (result.stdout || "").trim()];
}

function computeBriefEngagementRate(): [number | null, string | null] {
  const queries = [
    `
        SELECT CASE
            WHEN COUNT(*) = 0 THEN NULL
            ELSE ROUND(SUM(CASE WHEN (responded_at IS NOT NULL AND responded_at <= brief_at + INTERVAL '2 hours') THEN 1 ELSE 0 END)::numeric / COUNT(*), 4)
        END
        FROM cortana_feedback_signals
        WHERE brief_at >= NOW() - INTERVAL '7 days'
          AND (signal_type ILIKE '%brief%' OR metadata::text ILIKE '%brief%');
        `,
    `
        SELECT CASE
            WHEN COUNT(*) = 0 THEN NULL
            ELSE ROUND(SUM(CASE WHEN (responded_at IS NOT NULL AND responded_at <= timestamp + INTERVAL '2 hours') THEN 1 ELSE 0 END)::numeric / COUNT(*), 4)
        END
        FROM cortana_feedback_signals
        WHERE timestamp >= NOW() - INTERVAL '7 days'
          AND (signal_type ILIKE '%brief%' OR metadata::text ILIKE '%brief%');
        `,
    `
        SELECT CASE
            WHEN COUNT(*) = 0 THEN NULL
            ELSE ROUND(AVG(CASE WHEN (metadata->>'responded_within_2h')::boolean THEN 1.0 ELSE 0.0 END)::numeric, 4)
        END
        FROM cortana_feedback_signals
        WHERE COALESCE(timestamp, created_at, NOW()) >= NOW() - INTERVAL '7 days'
          AND (COALESCE(signal_type, '') ILIKE '%brief%' OR metadata::text ILIKE '%brief%');
        `,
  ];

  let lastErr: string | null = null;
  for (const q of queries) {
    const [ok, out] = runPsql(q);
    if (!ok) {
      lastErr = out;
      continue;
    }

    const trimmed = out.trim();
    if (trimmed === "" || trimmed.toLowerCase() === "null") {
      return [null, null];
    }

    try {
      const line = trimmed.split(/\r?\n/).pop() ?? "";
      return [Number.parseFloat(line.trim()), null];
    } catch {
      lastErr = `unexpected psql output: ${trimmed.slice(0, 120)}`;
    }
  }

  if (lastErr) {
    const errLower = lastErr.toLowerCase();
    if (errLower.includes("does not exist") || errLower.includes("relation")) {
      return [null, null];
    }
  }
  return [null, lastErr];
}

function main(): number {
  const [topCostCrons, subagentCost, subagentCount, anomalies] = analyzeSessions();
  const [briefRate, briefErr] = computeBriefEngagementRate();

  if (briefErr) {
    anomalies.push(`brief engagement query issue: ${briefErr.slice(0, 140)}`);
  }

  const result = {
    top_cost_crons: topCostCrons,
    subagent_cost_7d: subagentCost,
    subagent_spawn_count: subagentCount,
    brief_engagement_rate: briefRate,
    analysis_date: new Date().toISOString(),
    anomalies,
  };

  try {
    writeJsonFileAtomic(OUTPUT_PATH, result, 2);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ error: `failed to write output: ${msg}` }));
    return 1;
  }

  return 0;
}

process.exit(main());
