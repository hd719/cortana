#!/usr/bin/env npx tsx
import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import db from "../lib/db.js";
const { runPsql, withPostgresPath } = db;
import { PSQL_BIN, repoRoot } from "../lib/paths.js";

type BulletRow = { line: number; raw: string; norm: string };

type ExactDuplicateGroup = {
  normalized: string;
  occurrences: Array<{ line: number; raw: string; norm: string }>;
};

type NearDuplicate = {
  score: number;
  a: { line: number; text: string };
  b: { line: number; text: string };
};

function pad(num: number, len = 2): string {
  return String(num).padStart(len, "0");
}

function formatRunTimestamp(): string {
  try {
    return execSync("date '+%Y-%m-%d %H:%M:%S %Z'", { encoding: "utf8" }).trim();
  } catch {
    const now = new Date();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
      now.getHours()
    )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }
}

function formatRunId(): string {
  try {
    return execSync("date '+%Y%m%d-%H%M%S'", { encoding: "utf8" }).trim();
  } catch {
    const now = new Date();
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
      now.getHours()
    )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function dateAtMidnight(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function parseIsoDate(raw: string): Date | null {
  const [y, m, d] = raw.split("-").map((part) => Number(part));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

function parseUsDate(raw: string): Date | null {
  const parts = raw.split("/");
  if (parts.length !== 3) return null;
  const m = Number(parts[0]);
  const d = Number(parts[1]);
  if (!Number.isFinite(m) || !Number.isFinite(d)) return null;
  let y = Number(parts[2]);
  if (!Number.isFinite(y)) return null;
  if (parts[2].length === 2) {
    y = y <= 68 ? 2000 + y : 1900 + y;
  }
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function parseMonthDate(raw: string): Date | null {
  const match = raw.match(/^(\w+)\s+(\d{1,2}),\s*(\d{4})$/i);
  if (!match) return null;
  const monthName = match[1]?.toLowerCase() ?? "";
  const monthIndex = MONTHS.indexOf(monthName);
  if (monthIndex === -1) return null;
  const day = Number(match[2]);
  const year = Number(match[3]);
  if (!Number.isFinite(day) || !Number.isFinite(year)) return null;
  const dt = new Date(year, monthIndex, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== monthIndex || dt.getDate() !== day) {
    return null;
  }
  return dt;
}

function buildB2J(seq: string[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  seq.forEach((ch, idx) => {
    const arr = map.get(ch);
    if (arr) {
      arr.push(idx);
    } else {
      map.set(ch, [idx]);
    }
  });
  return map;
}

function findLongestMatch(
  a: string[],
  b: string[],
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
  b2j: Map<string, number[]>
): { i: number; j: number; size: number } {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  const j2len = new Map<number, number>();

  for (let i = alo; i < ahi; i += 1) {
    const newj2len = new Map<number, number>();
    const char = a[i];
    const indices = b2j.get(char);
    if (!indices) {
      j2len.clear();
      continue;
    }
    for (const j of indices) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len.clear();
    for (const [key, value] of newj2len.entries()) {
      j2len.set(key, value);
    }
  }

  while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
    besti -= 1;
    bestj -= 1;
    bestsize += 1;
  }
  while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) {
    bestsize += 1;
  }

  return { i: besti, j: bestj, size: bestsize };
}

function getMatchingBlocks(a: string[], b: string[]): Array<{ i: number; j: number; size: number }> {
  const b2j = buildB2J(b);
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]];
  const matchingBlocks: Array<{ i: number; j: number; size: number }> = [];

  while (queue.length > 0) {
    const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
    const match = findLongestMatch(a, b, alo, ahi, blo, bhi, b2j);
    if (match.size === 0) continue;
    matchingBlocks.push(match);
    if (alo < match.i && blo < match.j) {
      queue.push([alo, match.i, blo, match.j]);
    }
    const ahi2 = match.i + match.size;
    const bhi2 = match.j + match.size;
    if (ahi2 < ahi && bhi2 < bhi) {
      queue.push([ahi2, ahi, bhi2, bhi]);
    }
  }

  matchingBlocks.sort((x, y) => (x.i - y.i) || (x.j - y.j));

  // Collapse adjacent blocks
  const nonAdjacent: Array<{ i: number; j: number; size: number }> = [];
  let i1 = 0;
  let j1 = 0;
  let k1 = 0;
  for (const block of matchingBlocks) {
    if (i1 + k1 === block.i && j1 + k1 === block.j) {
      k1 += block.size;
    } else {
      if (k1) nonAdjacent.push({ i: i1, j: j1, size: k1 });
      i1 = block.i;
      j1 = block.j;
      k1 = block.size;
    }
  }
  if (k1) nonAdjacent.push({ i: i1, j: j1, size: k1 });
  nonAdjacent.push({ i: a.length, j: b.length, size: 0 });
  return nonAdjacent;
}

function sequenceMatcherRatio(a: string, b: string): number {
  const aSeq = Array.from(a);
  const bSeq = Array.from(b);
  if (aSeq.length === 0 && bSeq.length === 0) return 1;
  const matches = getMatchingBlocks(aSeq, bSeq).reduce((sum, block) => sum + block.size, 0);
  return (2 * matches) / (aSeq.length + bSeq.length);
}

async function main(): Promise<number> {
  const ROOT_DIR = repoRoot();
  const MEMORY_DIR = path.join(ROOT_DIR, "memory");
  const MEMORY_FILE = path.join(ROOT_DIR, "MEMORY.md");
  const ARCHIVE_ROOT = path.join(MEMORY_DIR, "archive");
  const REPORT_DIR = path.join(ROOT_DIR, "reports", "memory-compaction");

  const DB_NAME = process.env.DB_NAME ?? "cortana";

  const ARCHIVE_AFTER_DAYS = Number(process.env.ARCHIVE_AFTER_DAYS ?? "7");
  const STALE_AFTER_DAYS = Number(process.env.STALE_AFTER_DAYS ?? "90");
  const WARN_SIZE_BYTES = Number(process.env.WARN_SIZE_BYTES ?? "25600");
  const ALERT_SIZE_BYTES = Number(process.env.ALERT_SIZE_BYTES ?? "30720");

  fs.mkdirSync(ARCHIVE_ROOT, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const now = new Date();
  const RUN_TS = formatRunTimestamp();
  const RUN_ID = formatRunId();
  const REPORT_FILE = path.join(REPORT_DIR, `compaction-${RUN_ID}.md`);

  if (!fs.existsSync(MEMORY_FILE)) {
    process.stderr.write(`ERROR: MEMORY.md not found at ${MEMORY_FILE}\n`);
    return 1;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-memory-"));
  const archiveListFile = path.join(tempDir, "archive-list.txt");
  const dedupJsonFile = path.join(tempDir, "dedup.json");
  const staleJsonFile = path.join(tempDir, "stale.json");

  try {
    const cutoff = dateAtMidnight(new Date(now));
    cutoff.setDate(cutoff.getDate() - ARCHIVE_AFTER_DAYS);

    const archiveList: string[] = [];
    const pat = /^(\d{4})-(\d{2})-(\d{2})\.md$/;
    const entries = fs.existsSync(MEMORY_DIR) ? fs.readdirSync(MEMORY_DIR).sort() : [];
    for (const name of entries) {
      const full = path.join(MEMORY_DIR, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const match = pat.exec(name);
      if (!match) continue;
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const dt = new Date(year, month - 1, day);
      if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) {
        continue;
      }
      if (dt < cutoff) {
        archiveList.push(full);
      }
    }

    fs.writeFileSync(archiveListFile, archiveList.join("\n") + (archiveList.length ? "\n" : ""));

    let archivedCount = 0;
    for (const src of archiveList) {
      if (!src) continue;
      const base = path.basename(src);
      const year = base.slice(0, 4);
      const month = base.slice(5, 7);
      const targetDir = path.join(ARCHIVE_ROOT, year, month);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.renameSync(src, path.join(targetDir, base));
      archivedCount += 1;
    }

    const memoryText = fs.readFileSync(MEMORY_FILE, "utf8");
    const lines = memoryText.split(/\r?\n/);
    const bulletRe = /^\s*(?:[-*+]|\d+\.)\s+(.+?)\s*$/;
    const rows: BulletRow[] = [];

    lines.forEach((line, idx) => {
      const match = bulletRe.exec(line);
      if (!match) return;
      const raw = match[1] ?? "";
      let norm = raw.toLowerCase();
      norm = norm.replace(/[^a-z0-9\s]/g, "");
      norm = norm.replace(/\s+/g, " ").trim();
      if (!norm) return;
      rows.push({ line: idx + 1, raw, norm });
    });

    const exactMap = new Map<string, BulletRow[]>();
    for (const row of rows) {
      const list = exactMap.get(row.norm);
      if (list) {
        list.push(row);
      } else {
        exactMap.set(row.norm, [row]);
      }
    }

    const exactDuplicates: ExactDuplicateGroup[] = [];
    for (const [norm, values] of exactMap.entries()) {
      if (values.length > 1) {
        exactDuplicates.push({ normalized: norm, occurrences: values });
      }
    }

    const nearDuplicates: NearDuplicate[] = [];
    const seenPairs = new Set<string>();
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i];
        const b = rows[j];
        if (a.norm === b.norm) continue;
        if (Math.abs(a.norm.length - b.norm.length) > 20) continue;
        const score = sequenceMatcherRatio(a.norm, b.norm);
        if (score >= 0.92) {
          const key = `${Math.min(a.line, b.line)}-${Math.max(a.line, b.line)}`;
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

    const dedupPayload = {
      bullet_count: rows.length,
      exact_duplicate_groups: exactDuplicates,
      near_duplicates: nearDuplicates,
    };
    fs.writeFileSync(dedupJsonFile, JSON.stringify(dedupPayload, null, 2));

    const staleCutoff = dateAtMidnight(new Date(now));
    staleCutoff.setDate(staleCutoff.getDate() - STALE_AFTER_DAYS);
    const isoPat = /\b(\d{4}-\d{2}-\d{2})\b/g;
    const usPat = /\b(\d{1,2}\/\d{1,2}\/\d{2,4})\b/g;
    const monthPat = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})\b/gi;

    const staleFlags: Array<{
      line: number;
      date: string;
      parsed_date: string;
      age_days: number;
      line_text: string;
    }> = [];

    lines.forEach((line, idx) => {
      const candidates: Array<[string, Date]> = [];
      for (const match of line.matchAll(isoPat)) {
        const raw = match[1];
        if (!raw) continue;
        const dt = parseIsoDate(raw);
        if (dt) candidates.push([raw, dt]);
      }
      for (const match of line.matchAll(usPat)) {
        const raw = match[1];
        if (!raw) continue;
        const dt = parseUsDate(raw);
        if (dt) candidates.push([raw, dt]);
      }
      for (const match of line.matchAll(monthPat)) {
        const raw = match[0];
        if (!raw) continue;
        const dt = parseMonthDate(raw);
        if (dt) candidates.push([raw, dt]);
      }

      for (const [raw, dt] of candidates) {
        if (dt < staleCutoff) {
          const ageDays = Math.floor(
            (dateAtMidnight(new Date(now)).getTime() - dateAtMidnight(dt).getTime()) /
              (24 * 3600 * 1000)
          );
          staleFlags.push({
            line: idx + 1,
            date: raw,
            parsed_date: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`,
            age_days: ageDays,
            line_text: line.trim(),
          });
        }
      }
    });

    fs.writeFileSync(
      staleJsonFile,
      JSON.stringify({ cutoff_days: STALE_AFTER_DAYS, flags: staleFlags }, null, 2)
    );

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

    const dedupExactCount = exactDuplicates.length;
    const dedupNearCount = nearDuplicates.length;
    const staleCount = staleFlags.length;

    const reportLines: string[] = [];
    reportLines.push("# Memory Compaction Report", "");
    reportLines.push(`- Run: ${RUN_TS}`);
    reportLines.push(`- Archived daily notes: ${archivedCount}`);
    reportLines.push(`- Exact duplicate groups in MEMORY.md: ${dedupExactCount}`);
    reportLines.push(`- Near-duplicate bullet pairs in MEMORY.md: ${dedupNearCount}`);
    reportLines.push(`- Stale date references (> ${STALE_AFTER_DAYS} days): ${staleCount}`);
    reportLines.push(`- MEMORY.md size: ${memorySizeBytes} bytes (${sizeStatus})`, "");

    reportLines.push("## Archived Files");
    if (archivedCount === 0) {
      reportLines.push("- None");
    } else {
      for (const file of archiveList) {
        if (file) reportLines.push(`- ${file}`);
      }
    }
    reportLines.push("");

    reportLines.push("## Duplicate / Near-Duplicate Findings");
    if (dedupExactCount === 0 && dedupNearCount === 0) {
      reportLines.push("- No duplicate bullets detected.");
    } else {
      if (dedupExactCount > 0) {
        reportLines.push("### Exact duplicate groups");
        for (const group of exactDuplicates) {
          const linesList = group.occurrences.map((occ) => String(occ.line)).join(", ");
          const sample = group.occurrences[0]?.raw ?? group.normalized;
          reportLines.push(`- Lines [${linesList}] → ${sample}`);
        }
      }

      if (dedupNearCount > 0) {
        reportLines.push("", "### Near-duplicate pairs (similarity >= 0.92)");
        for (const pair of nearDuplicates) {
          const scoreText = String(pair.score);
          reportLines.push(
            `- score=${scoreText}: L${pair.a.line} '${pair.a.text}' ~ L${pair.b.line} '${pair.b.text}'`
          );
        }
      }
    }

    reportLines.push("", "## Staleness Review Candidates");
    if (staleFlags.length === 0) {
      reportLines.push("- No stale date references found.");
    } else {
      for (const item of staleFlags) {
        reportLines.push(
          `- L${item.line} [${item.date} | ${item.age_days} days old] ${item.line_text}`
        );
      }
    }

    fs.writeFileSync(REPORT_FILE, reportLines.join("\n") + "\n");

    let severity = "info";
    if (
      sizeStatus === "warning" ||
      sizeStatus === "alert" ||
      dedupExactCount > 0 ||
      dedupNearCount > 0 ||
      staleCount > 0
    ) {
      severity = "warning";
    }
    if (sizeStatus === "alert") {
      severity = "critical";
    }

    const metadataJson = JSON.stringify({
      archived_count: archivedCount,
      dedup_exact_groups: dedupExactCount,
      dedup_near_pairs: dedupNearCount,
      stale_count: staleCount,
      memory_size_bytes: memorySizeBytes,
      size_status: sizeStatus,
      archive_after_days: ARCHIVE_AFTER_DAYS,
      stale_after_days: STALE_AFTER_DAYS,
      report_file: REPORT_FILE,
    });

    if (isExecutable(PSQL_BIN)) {
      const sql = `INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('memory_compaction', 'compact-memory.sh', '${sqlEscape(
        severity
      )}', '${sqlEscape(sizeMessage)}', $$${metadataJson}$$::jsonb);`;
      runPsql(sql, {
        db: DB_NAME,
        args: ["-v", "ON_ERROR_STOP=0"],
        env: withPostgresPath(process.env),
        stdio: ["ignore", "ignore", "ignore"],
      });
    }

    console.log("Memory compaction complete");
    console.log(`- Archived files: ${archivedCount}`);
    console.log(`- Duplicate groups: ${dedupExactCount}`);
    console.log(`- Near-duplicate pairs: ${dedupNearCount}`);
    console.log(`- Stale candidates: ${staleCount}`);
    console.log(`- MEMORY.md size: ${memorySizeBytes} bytes (${sizeStatus})`);
    console.log(`- Report: ${REPORT_FILE}`);
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
