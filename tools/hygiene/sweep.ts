#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runPsql } from "../lib/db.js";

type Severity = "info" | "warn" | "critical";

type Finding = {
  check: string;
  severity: Severity;
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  recoverable?: boolean;
  cleaned?: boolean;
};

type Args = {
  command: "audit" | "clean" | "report";
  safe: boolean;
  dryRun: boolean;
  json: boolean;
  noLogEvent: boolean;
  verbose: boolean;
  staleSessionMinutes: number;
  staleFileDays: number;
  oversizedLogMb: number;
  migrationsDir: string;
  db: string;
  paths: string[];
};

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const DEFAULT_PATHS = [path.join(ROOT, "tmp"), path.join(ROOT, "logs"), path.join(ROOT, "cortical-loop", "logs")];
const DEFAULT_MIGRATIONS_DIR = path.join(ROOT, "migrations");
const SEVERITY_WEIGHT: Record<Severity, number> = { info: 1, warn: 4, critical: 10 };

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "audit",
    safe: false,
    dryRun: false,
    json: false,
    noLogEvent: false,
    verbose: false,
    staleSessionMinutes: 180,
    staleFileDays: 7,
    oversizedLogMb: 25,
    migrationsDir: DEFAULT_MIGRATIONS_DIR,
    db: "cortana",
    paths: [...DEFAULT_PATHS],
  };

  if (argv[0] === "audit" || argv[0] === "clean" || argv[0] === "report") {
    args.command = argv.shift() as Args["command"];
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--safe") args.safe = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--no-log-event") args.noLogEvent = true;
    else if (arg === "--verbose") args.verbose = true;
    else if (arg === "--stale-session-minutes") args.staleSessionMinutes = Number(argv[++i] ?? args.staleSessionMinutes);
    else if (arg === "--stale-file-days") args.staleFileDays = Number(argv[++i] ?? args.staleFileDays);
    else if (arg === "--oversized-log-mb") args.oversizedLogMb = Number(argv[++i] ?? args.oversizedLogMb);
    else if (arg === "--migrations-dir") args.migrationsDir = path.resolve(argv[++i] ?? args.migrationsDir);
    else if (arg === "--db") args.db = argv[++i] ?? args.db;
    else if (arg === "--paths") {
      const values: string[] = [];
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) values.push(path.resolve(argv[++i]));
      if (values.length > 0) args.paths = values;
    }
  }

  return args;
}

function readOpenClawSubagents(): Record<string, unknown> | null {
  const proc = spawnSync("openclaw", ["subagents", "list", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (proc.status !== 0) return null;
  try {
    const parsed = JSON.parse(proc.stdout || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function checkSubagents(args: Args): Finding[] {
  const data = readOpenClawSubagents();
  if (!data) {
    return [{
      check: "subagent_sessions",
      severity: "info",
      title: "Subagent runtime data unavailable",
      message: "openclaw subagents list --json was unavailable; no queue fallback is used.",
      metadata: { threshold_minutes: args.staleSessionMinutes },
    }];
  }

  const staleMs = args.staleSessionMinutes * 60 * 1000;
  const active = Array.isArray(data.active) ? data.active as Array<Record<string, unknown>> : [];
  const recent = Array.isArray(data.recent) ? data.recent as Array<Record<string, unknown>> : [];
  const findings: Finding[] = [];
  const stale = active.filter((session) => Number(session.runtimeMs ?? 0) > staleMs);

  findings.push(stale.length > 0 ? {
    check: "subagent_sessions",
    severity: "critical",
    title: "Stale active subagent sessions",
    message: `${stale.length} running subagent session(s) exceeded stale threshold.`,
    metadata: { threshold_minutes: args.staleSessionMinutes, sessions: stale.slice(0, 25) },
  } : {
    check: "subagent_sessions",
    severity: "info",
    title: "No stale active subagent sessions",
    message: "All active subagent sessions are within freshness threshold.",
    metadata: { active_count: active.length, threshold_minutes: args.staleSessionMinutes },
  });

  const failed = recent.filter((session) => ["failed", "timeout"].includes(String(session.status ?? "")));
  if (failed.length > 0) {
    findings.push({
      check: "subagent_sessions",
      severity: "warn",
      title: "Recent failed or timed-out subagent sessions",
      message: `Detected ${failed.length} recent subagent failure(s).`,
      metadata: { sessions: failed.slice(0, 25) },
    });
  }

  return findings;
}

function listFiles(basePaths: string[]): string[] {
  const files: string[] = [];
  const walk = (filePath: string) => {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    if (stat.isFile()) {
      files.push(filePath);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const child of fs.readdirSync(filePath)) walk(path.join(filePath, child));
  };
  for (const base of basePaths) walk(base);
  return files;
}

function checkStaleFiles(args: Args): Finding {
  const now = Date.now();
  const staleMs = args.staleFileDays * 24 * 60 * 60 * 1000;
  const stale = listFiles(args.paths).filter((filePath) => now - fs.statSync(filePath).mtimeMs >= staleMs);

  if (stale.length === 0) {
    return {
      check: "stale_files",
      severity: "info",
      title: "No stale temp or log files",
      message: "No stale files found under configured temp/log paths.",
      metadata: { paths: args.paths, stale_file_days: args.staleFileDays },
      recoverable: true,
    };
  }

  let deleted = 0;
  if (args.command === "clean" && args.safe) {
    for (const filePath of stale) {
      if (!args.dryRun) fs.rmSync(filePath, { force: true });
      deleted += 1;
    }
  }

  return {
    check: "stale_files",
    severity: "warn",
    title: "Stale temp or log files detected",
    message: `Found ${stale.length} stale file(s).${deleted ? ` ${args.dryRun ? "Would remove" : "Removed"} ${deleted}.` : ""}`,
    metadata: { count: stale.length, sample: stale.slice(0, 25).map((filePath) => path.relative(ROOT, filePath)), deleted, dry_run: args.dryRun },
    recoverable: true,
    cleaned: deleted > 0,
  };
}

function checkMigrationPrefixes(args: Args): Finding {
  if (!fs.existsSync(args.migrationsDir)) {
    return {
      check: "migration_prefixes",
      severity: "info",
      title: "Migration directory missing",
      message: "No migrations directory found; skipping duplicate prefix scan.",
      metadata: { path: args.migrationsDir },
    };
  }

  const buckets = new Map<string, string[]>();
  for (const name of fs.readdirSync(args.migrationsDir)) {
    if (!name.endsWith(".sql")) continue;
    const prefix = name.split("_", 1)[0];
    if (!/^\d+$/.test(prefix)) continue;
    buckets.set(prefix, [...(buckets.get(prefix) ?? []), name]);
  }
  const duplicates = [...buckets.entries()].filter(([, names]) => names.length > 1);

  return duplicates.length > 0 ? {
    check: "migration_prefixes",
    severity: "critical",
    title: "Duplicate migration prefixes detected",
    message: `Detected ${duplicates.length} duplicate migration prefix group(s).`,
    metadata: { duplicates: Object.fromEntries(duplicates) },
  } : {
    check: "migration_prefixes",
    severity: "info",
    title: "Migration prefixes are unique",
    message: "No duplicate numeric migration prefixes found.",
    metadata: { scanned_files: [...buckets.values()].flat().length },
  };
}

function checkOversizedLogs(args: Args): Finding {
  const maxBytes = args.oversizedLogMb * 1024 * 1024;
  const logs = listFiles(args.paths).filter((filePath) => {
    const name = path.basename(filePath).toLowerCase();
    return name.endsWith(".log") && (name.includes("session") || name.includes("subagent") || name.includes("agent"));
  });
  const oversized = logs.filter((filePath) => fs.statSync(filePath).size > maxBytes);

  if (oversized.length === 0) {
    return {
      check: "oversized_session_logs",
      severity: "info",
      title: "No oversized session logs",
      message: "No session log exceeded configured size threshold.",
      metadata: { threshold_mb: args.oversizedLogMb, candidates: logs.length },
      recoverable: true,
    };
  }

  let processed = 0;
  if (args.command === "clean" && args.safe) {
    for (const filePath of oversized) {
      if (!args.dryRun) fs.writeFileSync(filePath, "");
      processed += 1;
    }
  }

  return {
    check: "oversized_session_logs",
    severity: "warn",
    title: "Oversized session logs detected",
    message: `Found ${oversized.length} oversized session log(s).${processed ? ` ${args.dryRun ? "Would truncate" : "Truncated"} ${processed}.` : ""}`,
    metadata: { threshold_mb: args.oversizedLogMb, logs: oversized.slice(0, 25).map((filePath) => path.relative(ROOT, filePath)), processed, dry_run: args.dryRun },
    recoverable: true,
    cleaned: processed > 0,
  };
}

function summarize(args: Args, findings: Finding[]) {
  const counts: Record<Severity, number> = { info: 0, warn: 0, critical: 0 };
  let weighted = 0;
  let cleanedItems = 0;
  for (const finding of findings) {
    counts[finding.severity] += 1;
    weighted += SEVERITY_WEIGHT[finding.severity];
    if (finding.cleaned) cleanedItems += 1;
  }
  const riskScore = findings.length === 0 ? 0 : Math.min(100, Math.round((weighted / (findings.length * SEVERITY_WEIGHT.critical)) * 100));
  return { mode: args.command, safe: args.safe, dry_run: args.dryRun, risk_score: riskScore, counts, cleaned_items: cleanedItems, findings };
}

function logEvent(args: Args, summary: ReturnType<typeof summarize>): void {
  const severity = summary.counts.critical > 0 ? "critical" : summary.counts.warn > 0 ? "warning" : "info";
  const metadata = JSON.stringify({ ...summary, timestamp: new Date().toISOString() }).replace(/'/g, "''");
  const message = `System hygiene sweep ${summary.mode}: risk=${summary.risk_score}`.replace(/'/g, "''");
  const proc = runPsql(`
INSERT INTO cortana_events (event_type, source, severity, message, metadata)
VALUES ('system_hygiene', 'tools/hygiene/sweep.ts', '${severity}', '${message}', '${metadata}'::jsonb);
`, { db: args.db });
  if (proc.status !== 0 && args.verbose) {
    console.error(`[warn] failed to write cortana_events: ${(proc.stderr || proc.stdout || "").trim()}`);
  }
}

function printHuman(summary: ReturnType<typeof summarize>): void {
  console.log(`mode=${summary.mode} safe=${summary.safe} dry_run=${summary.dry_run}`);
  console.log(`risk_score=${summary.risk_score} info=${summary.counts.info} warn=${summary.counts.warn} critical=${summary.counts.critical} cleaned=${summary.cleaned_items}`);
  for (const finding of summary.findings) {
    console.log(`- [${finding.severity}] ${finding.check}: ${finding.title}`);
    console.log(`  ${finding.message}`);
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "clean" && !args.safe) {
    console.error("error: clean requires --safe");
    return 2;
  }

  const findings = [
    ...checkSubagents(args),
    checkStaleFiles(args),
    checkMigrationPrefixes(args),
    checkOversizedLogs(args),
  ];
  const summary = summarize(args, findings);

  if (args.command === "report" && args.json) console.log(JSON.stringify(summary, null, 2));
  else printHuman(summary);

  if (!args.noLogEvent) logEvent(args, summary);
  return 0;
}

process.exit(main());
