#!/usr/bin/env npx tsx
import fs from "fs";
import path from "path";
import db from "../lib/db.js";
const { runPsql, withPostgresPath } = db;
import { resolveHomePath } from "../lib/paths.js";

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  const scaled = value * factor;
  const sign = scaled < 0 ? -1 : 1;
  const abs = Math.abs(scaled);
  const floor = Math.floor(abs);
  const diff = abs - floor;
  let rounded = floor;
  if (diff > 0.5) {
    rounded = floor + 1;
  } else if (diff === 0.5) {
    rounded = floor % 2 === 0 ? floor : floor + 1;
  }
  return (rounded * sign) / factor;
}

function listJsonFiles(baseDir: string): string[] {
  const results: string[] = [];
  const stack = [baseDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

async function main(): Promise<number> {
  const baseDir = resolveHomePath(".openclaw", "sessions");
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;

  const sizes = new Map<string, number>();
  let subTotal = 0;
  let subCount = 0;

  for (const filePath of listJsonFiles(baseDir)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (stat.mtimeMs < weekAgo) continue;
    const kb = stat.size / 1024;
    const name = path.basename(filePath);
    let key = "unknown";
    const match = name.match(/cron:([^:]+):run/);
    if (match) {
      key = `cron:${match[1]}`;
    }
    sizes.set(key, (sizes.get(key) ?? 0) + kb);
    if (name.includes("subagent")) {
      subTotal += kb;
      subCount += 1;
    }
  }

  const top = Array.from(sizes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const cronCost = top.map(([label, value]) => ({
    label,
    kb: roundTo(value, 1),
    est_usd: roundTo(value * 0.015, 2),
  }));

  const query = `
SELECT
  COUNT(*) FILTER (
    WHERE lower(coalesce(context::text,'')) LIKE '%respond%'
       OR lower(signal_type) LIKE '%reply%'
       OR lower(signal_type) LIKE '%engage%'
  )::float,
  COUNT(*)::float
FROM cortana_feedback_signals
WHERE (lower(signal_type) LIKE '%brief%' OR lower(coalesce(related_rule,'')) LIKE '%brief%')
  AND timestamp > NOW()-INTERVAL '7 days';
`;

  let briefNum = 0.0;
  let briefDen = 0.0;

  const res = runPsql(query, {
    db: "cortana",
    args: ["-t", "-A", "-F", ","],
    env: withPostgresPath(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (res.status === 0) {
    const out = (res.stdout ?? "").toString().trim();
    if (out) {
      const parts = out.split(",");
      const a = parts[0] ?? "0";
      const b = parts[1] ?? "0";
      briefNum = Number(a || 0);
      briefDen = Number(b || 0);
    }
  }

  const rate = briefDen ? briefNum / briefDen : null;
  const analysisDate = new Date();
  const dateStr = `${analysisDate.getFullYear()}-${String(analysisDate.getMonth() + 1).padStart(2, "0")}-${String(
    analysisDate.getDate()
  ).padStart(2, "0")}`;

  const payload = {
    analysis_date: dateStr,
    top_cost_crons: cronCost,
    subagent_cost_7d: {
      sessions: subCount,
      est_usd: roundTo(subTotal * 0.015, 2),
    },
    brief_engagement_rate: rate,
  };

  process.stdout.write(JSON.stringify(payload) + "\n");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
