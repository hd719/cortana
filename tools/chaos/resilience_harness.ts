#!/usr/bin/env npx tsx

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { runPsql, withPostgresPath } from "../lib/db.js";

type FailureResult = {
  failure_type: string;
  injected: boolean;
  healed: boolean;
  mttr_seconds: number | null;
  evidence_source: string | null;
  message: string;
  details: Record<string, unknown>;
};

type Args = {
  dryRun: boolean;
  safeWindow: string;
  waitSeconds: number;
  pollSeconds: number;
  staleHours: number;
  baselineDays: number;
  regressionThreshold: number;
  json: boolean;
  triggerImmuneScan: boolean;
};

const DEFAULT_TOKEN_FILE = path.join(os.homedir(), ".config/cortana/tokens/fitness.token");
const DEFAULT_CRON_OUTPUT = path.join(os.homedir(), "openclaw/logs/heartbeat.log");
const DEFAULT_SESSION_DIR = path.join(os.homedir(), ".local/share/openclaw/sessions");

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dryRun: false,
    safeWindow: "01:00-05:00",
    waitSeconds: 180,
    pollSeconds: 5,
    staleHours: 12,
    baselineDays: 14,
    regressionThreshold: 1.2,
    json: false,
    triggerImmuneScan: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--safe-window") args.safeWindow = argv[++i] ?? args.safeWindow;
    else if (a === "--wait-seconds") args.waitSeconds = Number.parseInt(argv[++i] ?? "180", 10);
    else if (a === "--poll-seconds") args.pollSeconds = Number.parseInt(argv[++i] ?? "5", 10);
    else if (a === "--stale-hours") args.staleHours = Number.parseInt(argv[++i] ?? "12", 10);
    else if (a === "--baseline-days") args.baselineDays = Number.parseInt(argv[++i] ?? "14", 10);
    else if (a === "--regression-threshold") args.regressionThreshold = Number.parseFloat(argv[++i] ?? "1.2");
    else if (a === "--json") args.json = true;
    else if (a === "--trigger-immune-scan") args.triggerImmuneScan = true;
  }
  return args;
}

class Harness {
  args: Args;
  runId: string;
  runStarted: Date;

  constructor(args: Args) {
    this.args = args;
    this.runId = randomUUID();
    this.runStarted = new Date();
  }

  async run(): Promise<number> {
    if (this.args.safeWindow && !inSafeWindow(this.args.safeWindow, new Date())) {
      console.error(`Refusing to run: outside safe window ${this.args.safeWindow}`);
      return 2;
    }

    const results = [
      await this.runExpiredToken(),
      await this.runMissingCronOutput(),
      await this.runStaleSessionFiles(),
    ];

    const summary = this.summarize(results);
    this.persist(results, summary);
    this.printReport(results, summary);

    return summary.pass ? 0 : 1;
  }

  async runExpiredToken(): Promise<FailureResult> {
    return this.executeScenario(
      "expired_token_file",
      () => injectExpiredToken(DEFAULT_TOKEN_FILE),
      (injectedAt) => tokenIsRepaired(DEFAULT_TOKEN_FILE, injectedAt),
      ["token", "refresh", "auto-fix", "watchdog", "immune"]
    );
  }

  async runMissingCronOutput(): Promise<FailureResult> {
    return this.executeScenario(
      "missing_cron_output",
      () => injectMissingFile(DEFAULT_CRON_OUTPUT),
      () => fs.existsSync(DEFAULT_CRON_OUTPUT),
      ["cron", "output", "auto-fix", "watchdog", "immune"]
    );
  }

  async runStaleSessionFiles(): Promise<FailureResult> {
    return this.executeScenario(
      "stale_session_files",
      () => injectStaleSession(DEFAULT_SESSION_DIR, this.args.staleHours),
      () => !hasStaleSessions(DEFAULT_SESSION_DIR, this.args.staleHours),
      ["session", "stale", "auto-fix", "watchdog", "immune"]
    );
  }

  async executeScenario(
    failureType: string,
    inject: () => Record<string, unknown>,
    healed: (injectedAt: Date) => boolean,
    eventKeywords: string[]
  ): Promise<FailureResult> {
    if (this.args.dryRun) {
      const simulated = Math.min(5.0, this.args.waitSeconds / 3);
      return {
        failure_type: failureType,
        injected: false,
        healed: true,
        mttr_seconds: simulated,
        evidence_source: "dry-run-simulation",
        message: "Simulated only (--dry-run)",
        details: { simulated: true },
      };
    }

    const restoreInfo = inject();
    const injectedAt = new Date();

    try {
      if (this.args.triggerImmuneScan) this.triggerImmuneScan();
      const wait = await this.waitForHeal(injectedAt, healed, failureType, eventKeywords);
      if (wait.healedAt) {
        const mttr = (wait.healedAt.getTime() - injectedAt.getTime()) / 1000;
        return {
          failure_type: failureType,
          injected: true,
          healed: true,
          mttr_seconds: mttr,
          evidence_source: wait.source,
          message: `Healed in ${mttr.toFixed(1)}s via ${wait.source}`,
          details: { injected_at: injectedAt.toISOString() },
        };
      }
      return {
        failure_type: failureType,
        injected: true,
        healed: false,
        mttr_seconds: null,
        evidence_source: null,
        message: `No healing signal within ${this.args.waitSeconds}s`,
        details: { injected_at: injectedAt.toISOString() },
      };
    } finally {
      safeRestore(restoreInfo);
    }
  }

  async waitForHeal(injectedAt: Date, healedAssertion: (injectedAt: Date) => boolean, failureType: string, eventKeywords: string[]) {
    const deadline = Date.now() + this.args.waitSeconds * 1000;
    while (Date.now() < deadline) {
      if (healedAssertion(injectedAt)) return { healedAt: new Date(), source: "file-state" };
      const evtTs = findHealingEvent(injectedAt, failureType, eventKeywords);
      if (evtTs) return { healedAt: evtTs, source: "cortana_events" };
      await new Promise((r) => setTimeout(r, this.args.pollSeconds * 1000));
    }
    return { healedAt: null as Date | null, source: null as string | null };
  }

  triggerImmuneScan(): void {
    const immuneScript = "/Users/hd/openclaw/tools/immune_scan.sh";
    if (!fs.existsSync(immuneScript)) return;
    spawnSync("bash", [immuneScript], { encoding: "utf8" });
  }

  summarize(results: FailureResult[]) {
    const mttrByType: Record<string, number> = {};
    for (const r of results) if (r.mttr_seconds !== null) mttrByType[r.failure_type] = r.mttr_seconds;
    const baseline = historicalMttrBaseline(this.args.baselineDays);
    const regressions: Record<string, Record<string, unknown>> = {};

    for (const [failureType, mttr] of Object.entries(mttrByType)) {
      const prev = baseline[failureType];
      if (prev === undefined || prev <= 0) continue;
      const regressed = mttr > prev * this.args.regressionThreshold;
      regressions[failureType] = {
        baseline_mttr: Number(prev.toFixed(2)),
        current_mttr: Number(mttr.toFixed(2)),
        threshold: this.args.regressionThreshold,
        regressed,
      };
    }

    const passState = results.every((r) => r.healed) && !Object.values(regressions).some((v: any) => Boolean(v.regressed));
    return {
      run_id: this.runId,
      started_at: this.runStarted.toISOString(),
      dry_run: this.args.dryRun,
      safe_window: this.args.safeWindow,
      mttr_seconds: mttrByType,
      regressions,
      pass: passState,
    };
  }

  persist(results: FailureResult[], summary: Record<string, any>) {
    for (const result of results) {
      const payload = {
        run_id: this.runId,
        failure_type: result.failure_type,
        injected: result.injected,
        healed: result.healed,
        mttr_seconds: result.mttr_seconds,
        evidence_source: result.evidence_source,
        details: result.details,
      };
      insertEvent("resilience_harness", "resilience_harness", "info", `resilience_harness_result:${result.failure_type}`, payload);
    }

    insertEvent(
      "resilience_harness_summary",
      "resilience_harness",
      summary.pass ? "info" : "warning",
      "resilience_harness_summary",
      summary
    );
  }

  printReport(results: FailureResult[], summary: Record<string, any>) {
    const report = {
      run_id: this.runId,
      pass: summary.pass,
      dry_run: this.args.dryRun,
      results: results.map((r) => ({
        failure_type: r.failure_type,
        healed: r.healed,
        mttr_seconds: r.mttr_seconds,
        message: r.message,
      })),
      regressions: summary.regressions,
    };

    if (this.args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`Resilience Harness Run: ${this.runId}`);
    console.log(`Status: ${summary.pass ? "PASS" : "FAIL"}`);
    for (const r of results) {
      const mttr = r.mttr_seconds !== null ? `${r.mttr_seconds.toFixed(1)}s` : "n/a";
      console.log(` - ${r.failure_type}: healed=${r.healed} mttr=${mttr} (${r.message})`);
    }

    if (Object.keys(summary.regressions).length) {
      console.log("Regression checks:");
      for (const [ftype, data] of Object.entries<any>(summary.regressions)) {
        const flag = data.regressed ? "REGRESSION" : "ok";
        console.log(` - ${ftype}: current=${data.current_mttr}s baseline=${data.baseline_mttr}s -> ${flag}`);
      }
    }
  }
}

function inSafeWindow(window: string, now: Date): boolean {
  try {
    const [startStr, endStr] = window.split("-", 2);
    const [sh, sm] = startStr.split(":", 2).map((x) => Number.parseInt(x, 10));
    const [eh, em] = endStr.split(":", 2).map((x) => Number.parseInt(x, 10));
    const n = now.getHours() * 60 + now.getMinutes();
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (start <= end) return n >= start && n <= end;
    return n >= start || n <= end;
  } catch {
    return false;
  }
}

function injectExpiredToken(tokenPath: string): Record<string, unknown> {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  const backup = fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath) : null;
  fs.writeFileSync(tokenPath, "EXPIRED_TOKEN_MARKER\n", "utf8");
  const oldTs = Date.now() / 1000 - 72 * 3600;
  fs.utimesSync(tokenPath, oldTs, oldTs);
  return { kind: "token", path: tokenPath, backup };
}

function injectMissingFile(filePath: string): Record<string, unknown> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let backupPath: string | null = null;
  if (fs.existsSync(filePath)) {
    backupPath = `${filePath}.bak.${Math.trunc(Date.now() / 1000)}`;
    fs.renameSync(filePath, backupPath);
  } else {
    fs.writeFileSync(filePath, "placeholder\n", "utf8");
    fs.rmSync(filePath, { force: true });
  }
  return { kind: "missing", path: filePath, backup_path: backupPath };
}

function injectStaleSession(sessionDir: string, staleHours: number): Record<string, unknown> {
  fs.mkdirSync(sessionDir, { recursive: true });
  const staleFile = path.join(sessionDir, `harness_stale_${Math.trunc(Date.now() / 1000)}.session`);
  fs.writeFileSync(staleFile, "stale session marker\n", "utf8");
  const oldTs = Date.now() / 1000 - Math.max(2, staleHours + 2) * 3600;
  fs.utimesSync(staleFile, oldTs, oldTs);
  return { kind: "stale", path: staleFile };
}

function tokenIsRepaired(tokenPath: string, injectedAt: Date): boolean {
  if (!fs.existsSync(tokenPath)) return false;
  let txt = "";
  try {
    txt = fs.readFileSync(tokenPath, "utf8");
  } catch {
    txt = "";
  }
  if (txt.includes("EXPIRED_TOKEN_MARKER")) return false;
  return fs.statSync(tokenPath).mtime.getTime() >= injectedAt.getTime();
}

function hasStaleSessions(sessionDir: string, staleHours: number): boolean {
  if (!fs.existsSync(sessionDir)) return false;
  const cutoff = Date.now() - staleHours * 3600 * 1000;
  for (const f of fs.readdirSync(sessionDir)) {
    if (!f.endsWith(".session")) continue;
    const p = path.join(sessionDir, f);
    try {
      if (fs.statSync(p).mtime.getTime() < cutoff) return true;
    } catch {}
  }
  return false;
}

function safeRestore(restoreInfo: Record<string, unknown>): void {
  const kind = String(restoreInfo.kind ?? "");
  if (kind === "token") {
    const p = String(restoreInfo.path);
    const backup = restoreInfo.backup as Buffer | null;
    if (backup === null) fs.rmSync(p, { force: true });
    else fs.writeFileSync(p, backup);
  } else if (kind === "missing") {
    const p = String(restoreInfo.path);
    const backup = restoreInfo.backup_path ? String(restoreInfo.backup_path) : "";
    if (backup && fs.existsSync(backup)) fs.renameSync(backup, p);
    else fs.closeSync(fs.openSync(p, "a"));
  } else if (kind === "stale") {
    fs.rmSync(String(restoreInfo.path), { force: true });
  }
}

function findHealingEvent(startedAt: Date, failureType: string, keywords: string[]): Date | null {
  const search = keywords.map((k) => `message ILIKE '%${sqlEscape(k)}%'`).join(" OR ");
  const sql = `
SELECT to_char(timestamp, 'YYYY-MM-DD"T"HH24:MI:SS')
FROM cortana_events
WHERE timestamp >= '${fmt(startedAt)}'
  AND (
    metadata::text ILIKE '%${sqlEscape(failureType)}%'
    OR ${search}
  )
ORDER BY timestamp ASC
LIMIT 1;
`;
  const out = runPsqlScalar(sql);
  if (!out) return null;
  const d = new Date(out);
  return Number.isNaN(d.getTime()) ? null : d;
}

function historicalMttrBaseline(days: number): Record<string, number> {
  const sql = `
SELECT COALESCE(json_object_agg(failure_type, avg_mttr), '{}'::json)
FROM (
  SELECT
    metadata->>'failure_type' AS failure_type,
    AVG((metadata->>'mttr_seconds')::numeric)::float AS avg_mttr
  FROM cortana_events
  WHERE event_type = 'resilience_harness'
    AND timestamp >= NOW() - INTERVAL '${Math.trunc(days)} days'
    AND (metadata->>'mttr_seconds') IS NOT NULL
  GROUP BY 1
) t;
`;
  const out = runPsqlScalar(sql);
  if (!out) return {};
  try {
    const obj = JSON.parse(out);
    const outMap: Record<string, number> = {};
    for (const [k, v] of Object.entries<any>(obj)) if (v !== null) outMap[k] = Number(v);
    return outMap;
  } catch {
    return {};
  }
}

function insertEvent(eventType: string, source: string, severity: string, message: string, metadata: Record<string, unknown>): void {
  const sql =
    "INSERT INTO cortana_events (event_type, source, severity, message, metadata) " +
    `VALUES ('${sqlEscape(eventType)}', '${sqlEscape(source)}', '${sqlEscape(severity)}', ` +
    `'${sqlEscape(message)}', '${sqlEscape(JSON.stringify(metadata))}'::jsonb);`;
  runPsqlExec(sql);
}

function runPsqlExec(sql: string): void {
  const proc = runPsql(sql, { db: "cortana", args: ["-X", "-v", "ON_ERROR_STOP=1"], env: withPostgresPath({ ...process.env }) });
  if (proc.status !== 0) console.error(`[warn] psql write failed: ${(proc.stderr || "").trim()}`);
}

function runPsqlScalar(sql: string): string {
  const proc = runPsql(sql, { db: "cortana", args: ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1"], env: withPostgresPath({ ...process.env }) });
  if (proc.status !== 0) return "";
  return (proc.stdout || "").trim();
}

function sqlEscape(value: string): string {
  return (value || "").replaceAll("'", "''");
}

function fmt(d: Date): string {
  const p = (n: number) => `${n}`.padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const harness = new Harness(args);
  return harness.run();
}

main().then((code) => process.exit(code));
