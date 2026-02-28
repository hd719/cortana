#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { resolveRepoPath } from "../lib/paths.js";

const ROOT_DIR = resolveRepoPath();
const MEMORY_DIR = path.join(ROOT_DIR, "memory");
const MEMORY_FILE = path.join(ROOT_DIR, "MEMORY.md");
const ARCHIVE_ROOT = path.join(MEMORY_DIR, "archive");
const REPORT_DIR = path.join(ROOT_DIR, "reports/memory-compaction");

const DB_NAME = process.env.DB_NAME ?? "cortana";
const PSQL_BIN = process.env.PSQL_BIN ?? "/opt/homebrew/opt/postgresql@17/bin/psql";

const ARCHIVE_AFTER_DAYS = Number.parseInt(process.env.ARCHIVE_AFTER_DAYS ?? "7", 10);
const STALE_AFTER_DAYS = Number.parseInt(process.env.STALE_AFTER_DAYS ?? "90", 10);
const WARN_SIZE_BYTES = Number.parseInt(process.env.WARN_SIZE_BYTES ?? "25600", 10);
const ALERT_SIZE_BYTES = Number.parseInt(process.env.ALERT_SIZE_BYTES ?? "30720", 10);

function getDateStamp(fmt: string): string {
  const proc = spawnSync("date", [fmt], { encoding: "utf8" });
  return (proc.stdout || "").trim();
}

function parseDateFromFilename(name: string): Date | null {
  const match = name.match(/^(\d{4})-(\d{2})-(\d{2})\.md$/);
  if (!match) return null;
  const [_, y, m, d] = match;
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function lcsLength(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function similarityRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  const lcs = lcsLength(a, b);
  return (2 * lcs) / (a.length + b.length);
}

function parseDateCandidates(line: string): Array<{ raw: string; date: Date }> {
  const results: Array<{ raw: string; date: Date }> = [];
  const isoPat = /\b(\d{4}-\d{2}-\d{2})\b/g;
  const usPat = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/g;
  const monthPat = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})\b/gi;

  for (const m of line.matchAll(isoPat)) {
    const raw = m[1];
    const d = new Date(`${raw}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) results.push({ raw, date: d });
  }

  for (const m of line.matchAll(usPat)) {
    const raw = m[1];
    const parts = raw.split("/");
    const mm = Number(parts[0]);
    const dd = Number(parts[1]);
    let yy = Number(parts[2]);
    if (parts[2].length === 2) {
      yy += yy >= 70 ? 1900 : 2000;
    }
    const d = new Date(Date.UTC(yy, mm - 1, dd));
    if (!Number.isNaN(d.getTime())) results.push({ raw, date: d });
  }

  for (const m of line.matchAll(monthPat)) {
    const raw = m[0];
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) results.push({ raw, date: d });
  }

  return results;
}

function main(): number {
  fs.mkdirSync(ARCHIVE_ROOT, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const runTs = getDateStamp("+%Y-%m-%d %H:%M:%S %Z");
  const runId = getDateStamp("+%Y%m%d-%H%M%S");
  const reportFile = path.join(REPORT_DIR, `compaction-${runId}.md`);

  if (!fs.existsSync(MEMORY_FILE)) {
    console.error(`ERROR: MEMORY.md not found at ${MEMORY_FILE}`);
    return 1;
  }

  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - ARCHIVE_AFTER_DAYS);

  const archiveList: string[] = [];
  for (const name of fs.readdirSync(MEMORY_DIR)) {
    const full = path.join(MEMORY_DIR, name);
    if (!fs.statSync(full).isFile()) continue;
    const dt = parseDateFromFilename(name);
    if (!dt) continue;
    if (dt < cutoffDate) {
      archiveList.push(full);
    }
  }

  let archivedCount = 0;
  for (const src of archiveList) {
    const base = path.basename(src);
    const year = base.slice(0, 4);
    const month = base.slice(5, 7);
    const targetDir = path.join(ARCHIVE_ROOT, year, month);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.renameSync(src, path.join(targetDir, base));
    archivedCount += 1;
  }

  const memoryText = fs.readFileSync(MEMORY_FILE, "utf8");
  const bulletRe = /^\s*(?:[-*+]|\d+\.)\s+(.+?)\s*$/;
  const rows: Array<{ line: number; raw: string; norm: string }> = [];
  memoryText.split(/\r?\n/).forEach((line, idx) => {
    const match = line.match(bulletRe);
    if (!match) return;
    const raw = match[1];
    let norm = raw.toLowerCase().replace(/[^a-z0-9\s]/g, "");
    norm = norm.replace(/\s+/g, " ").trim();
    if (!norm) return;
    rows.push({ line: idx + 1, raw, norm });
  });

  const exactGroups: Array<{ normalized: string; occurrences: Array<{ line: number; raw: string; norm: string }> }> = [];
  const byNorm = new Map<string, Array<{ line: number; raw: string; norm: string }>>();
  for (const row of rows) {
    const list = byNorm.get(row.norm) ?? [];
    list.push(row);
    byNorm.set(row.norm, list);
  }
  for (const [norm, vals] of byNorm.entries()) {
    if (vals.length > 1) {
      exactGroups.push({ normalized: norm, occurrences: vals });
    }
  }

  const nearDuplicates: Array<{ score: number; a: { line: number; text: string }; b: { line: number; text: string } }> = [];
  const seenPairs = new Set<string>();
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i];
      const b = rows[j];
      if (a.norm === b.norm) continue;
      if (Math.abs(a.norm.length - b.norm.length) > 20) continue;
      const score = similarityRatio(a.norm, b.norm);
      if (score >= 0.92) {
        const key = [a.line, b.line].sort((x, y) => x - y).join("-");
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        nearDuplicates.push({
          score: Math.round(score * 1000) / 1000,
          a: { line: a.line, text: a.raw },
          b: { line: b.line, text: b.raw },
        });
      }
    }
  }

  nearDuplicates.sort((x, y) => y.score - x.score);

  const staleFlags: Array<{ line: number; date: string; parsed_date: string; age_days: number; line_text: string }> = [];
  const staleCutoff = new Date();
  staleCutoff.setUTCDate(staleCutoff.getUTCDate() - STALE_AFTER_DAYS);

  memoryText.split(/\r?\n/).forEach((line, idx) => {
    const candidates = parseDateCandidates(line);
    for (const { raw, date } of candidates) {
      if (date < staleCutoff) {
        const ageDays = Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
        staleFlags.push({
          line: idx + 1,
          date: raw,
          parsed_date: date.toISOString().slice(0, 10),
          age_days: ageDays,
          line_text: line.trim(),
        });
      }
    }
  });

  const memorySizeBytes = fs.statSync(MEMORY_FILE).size;
  let sizeStatus = "ok";
  let sizeMessage = "MEMORY.md size within threshold";
  if (memorySizeBytes > ALERT_SIZE_BYTES) {
    sizeStatus = "alert";
    sizeMessage = `MEMORY.md exceeds alert threshold (${ALERT_SIZE_BYTES} bytes)`;
  } else if (memorySizeBytes > WARN_SIZE_BYTES) {
    sizeStatus = "warning";
    sizeMessage = `MEMORY.md exceeds warning threshold (${WARN_SIZE_BYTES} bytes)`;
  }

  const dedupExactCount = exactGroups.length;
  const dedupNearCount = nearDuplicates.length;
  const staleCount = staleFlags.length;

  const reportLines: string[] = [];
  reportLines.push("# Memory Compaction Report");
  reportLines.push("");
  reportLines.push(`- Run: ${runTs}`);
  reportLines.push(`- Archived daily notes: ${archivedCount}`);
  reportLines.push(`- Exact duplicate groups in MEMORY.md: ${dedupExactCount}`);
  reportLines.push(`- Near-duplicate bullet pairs in MEMORY.md: ${dedupNearCount}`);
  reportLines.push(`- Stale date references (> ${STALE_AFTER_DAYS} days): ${staleCount}`);
  reportLines.push(`- MEMORY.md size: ${memorySizeBytes} bytes (${sizeStatus})`);
  reportLines.push("");
  reportLines.push("## Archived Files");
  if (archivedCount === 0) {
    reportLines.push("- None");
  } else {
    for (const f of archiveList) {
      if (f) reportLines.push(`- ${f}`);
    }
  }
  reportLines.push("");
  reportLines.push("## Duplicate / Near-Duplicate Findings");
  if (!exactGroups.length && !nearDuplicates.length) {
    reportLines.push("- No duplicate bullets detected.");
  } else {
    if (exactGroups.length) {
      reportLines.push("### Exact duplicate groups");
      for (const g of exactGroups) {
        const occ = g.occurrences;
        const lines = occ.map((x) => String(x.line)).join(", ");
        const sample = occ[0]?.raw ?? g.normalized;
        reportLines.push(`- Lines [${lines}] → ${sample}`);
      }
    }
    if (nearDuplicates.length) {
      reportLines.push("");
      reportLines.push("### Near-duplicate pairs (similarity >= 0.92)");
      for (const pair of nearDuplicates) {
        reportLines.push(`- score=${pair.score}: L${pair.a.line} '${pair.a.text}' ~ L${pair.b.line} '${pair.b.text}'`);
      }
    }
  }
  reportLines.push("");
  reportLines.push("## Staleness Review Candidates");
  if (!staleFlags.length) {
    reportLines.push("- No stale date references found.");
  } else {
    for (const item of staleFlags) {
      reportLines.push(`- L${item.line} [${item.date} | ${item.age_days} days old] ${item.line_text}`);
    }
  }

  fs.writeFileSync(reportFile, reportLines.join("\n") + "\n");

  let severity = "info";
  if (sizeStatus === "warning" || sizeStatus === "alert" || dedupExactCount > 0 || dedupNearCount > 0 || staleCount > 0) {
    severity = "warning";
  }
  if (sizeStatus === "alert") {
    severity = "critical";
  }

  const metadataJson = JSON.stringify(
    {
      archived_count: archivedCount,
      dedup_exact_groups: dedupExactCount,
      dedup_near_pairs: dedupNearCount,
      stale_count: staleCount,
      memory_size_bytes: memorySizeBytes,
      size_status: sizeStatus,
      archive_after_days: ARCHIVE_AFTER_DAYS,
      stale_after_days: STALE_AFTER_DAYS,
      report_file: reportFile,
    },
    null,
    0
  );

  if (fs.existsSync(PSQL_BIN)) {
    const sql =
      "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES " +
      `('memory_compaction', 'compact-memory.sh', '${severity}', '${sizeMessage.replace(/'/g, "''")}', $$${metadataJson}$$::jsonb);`;
    spawnSync(PSQL_BIN, [DB_NAME, "-v", "ON_ERROR_STOP=0", "-c", sql], { encoding: "utf8" });
  }

  console.log("Memory compaction complete");
  console.log(`- Archived files: ${archivedCount}`);
  console.log(`- Duplicate groups: ${dedupExactCount}`);
  console.log(`- Near-duplicate pairs: ${dedupNearCount}`);
  console.log(`- Stale candidates: ${staleCount}`);
  console.log(`- MEMORY.md size: ${memorySizeBytes} bytes (${sizeStatus})`);
  console.log(`- Report: ${reportFile}`);

  return 0;
}

process.exit(main());
