#!/usr/bin/env npx tsx

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { readJsonFile, writeJsonFileAtomic } from "../lib/json-file.js";

const RUN_STORE_PATH = process.env.OPENCLAW_SUBAGENT_RUNS_PATH ?? path.join(os.homedir(), ".openclaw", "subagents", "runs.json");
const DB_NAME = "cortana";
const ACTIVE_MINUTES = 1440;
const STALE_STATUSES = new Set(["running", "in_progress"]);

const nowMs = () => Date.now();
const isoFromMs = (ms?: number | null) => (ms ? new Date(ms).toISOString() : null);
const sqlQuote = (value?: string | null) => (value ?? "").replace(/'/g, "''");

function resolvePsql(): string {
  const candidates = [process.env.PSQL_BIN, "/opt/homebrew/opt/postgresql@17/bin/psql", "psql"].filter(Boolean) as string[];
  for (const c of candidates) {
    if (c === "psql") {
      const proc = spawnSync("/usr/bin/env", ["bash", "-lc", "command -v psql"], { encoding: "utf8" });
      if (proc.status === 0 && (proc.stdout || "").trim()) return "psql";
      continue;
    }
    if (fs.existsSync(c)) return c;
  }
  return "psql";
}

function runSessions(activeMinutes = ACTIVE_MINUTES): any {
  const proc = spawnSync("openclaw", ["sessions", "--json", "--active", String(activeMinutes), "--all-agents"], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error((proc.stderr || proc.stdout || "openclaw sessions failed").trim());
  try { return JSON.parse(proc.stdout || "{}"); } catch (e: any) { throw new Error(`Invalid JSON from openclaw sessions: ${e.message}`); }
}

function collectSessionIds(session: any): Set<string> {
  return new Set([session.sessionId, session.runId, session.run_id, session.key].map((x) => String(x ?? "").trim()).filter(Boolean));
}

function collectRunIds(run: any): Set<string> {
  return new Set([run.childSessionKey, run.runId, run.sessionId].map((x) => String(x ?? "").trim()).filter(Boolean));
}

function logReapedEvent(psqlBin: string, metadata: Record<string, any>, message: string): [boolean, string | null] {
  const msgSql = sqlQuote(message);
  const metaSql = sqlQuote(JSON.stringify(metadata));
  const sql = "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('subagent_reaped', 'subagent-reaper', 'warning', '" + msgSql + "', '" + metaSql + "'::jsonb);";
  const proc = spawnSync(psqlBin, [DB_NAME, "-X", "-c", sql], { encoding: "utf8" });
  if (proc.error) return [false, `psql not found (${psqlBin})`];
  if (proc.status !== 0) return [false, (proc.stderr || proc.stdout || "psql insert failed").trim()];
  return [true, null];
}

function resetTasks(psqlBin: string, runId: string, label?: string | null, childKey?: string | null, outcome?: string): [boolean, string | null, number] {
  const conditions: string[] = [];
  const runQ = sqlQuote(runId);
  const labelQ = sqlQuote(label);
  const childQ = sqlQuote(childKey);

  if (runId) {
    conditions.push(`run_id='${runQ}'`);
    conditions.push(`COALESCE(metadata->>'subagent_run_id','')='${runQ}'`);
  }
  if (label) {
    conditions.push(`assigned_to='${labelQ}'`);
    conditions.push(`COALESCE(metadata->>'subagent_label','')='${labelQ}'`);
  }
  if (childKey) {
    conditions.push(`assigned_to='${childQ}'`);
    conditions.push(`COALESCE(metadata->>'subagent_session_key','')='${childQ}'`);
  }

  if (conditions.length === 0) return [true, null, 0];

  const sql = "UPDATE cortana_tasks SET status='ready', outcome='" + sqlQuote(outcome) + "', updated_at=NOW() WHERE status='in_progress' AND (" + conditions.join(" OR ") + ") RETURNING id;";
  const proc = spawnSync(psqlBin, [DB_NAME, "-X", "-t", "-A", "-c", sql], { encoding: "utf8" });
  if (proc.status !== 0) return [false, (proc.stderr || proc.stdout || "task update failed").trim(), 0];
  const rows = (proc.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return [true, null, rows.length];
}

function parseArgs(argv: string[]) {
  let maxAgeHours = 2.0;
  let dryRun = false;
  let emitJson = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--max-age-hours" && argv[i + 1]) {
      maxAgeHours = Number(argv[i + 1]);
      i += 1;
    } else if (a === "--dry-run") dryRun = true;
    else if (a === "--emit-json") emitJson = true;
  }
  return { maxAgeHours, dryRun, emitJson };
}

function main(): number {
  spawnSync("/Users/hd/openclaw/tools/heartbeat/validate-heartbeat-state.sh", { stdio: "ignore" });

  const args = parseArgs(process.argv.slice(2));
  const now = nowMs();
  const maxAgeMs = Math.floor(args.maxAgeHours * 3600 * 1000);

  const output: any = {
    ok: true,
    timestamp: isoFromMs(now),
    config: { maxAgeHours: args.maxAgeHours, dryRun: args.dryRun },
    summary: { runsScanned: 0, staleCandidates: 0, reapedRuns: 0, eventsLogged: 0, tasksReset: 0, errors: 0 },
    reaped: [],
    errors: [],
  };

  const payload = readJsonFile<any>(RUN_STORE_PATH) ?? {};
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    output.ok = false;
    output.error = "runs.json payload is not an object";
    console.log(args.emitJson ? JSON.stringify(output, null, 2) : "reaper: runs.json payload invalid");
    return 1;
  }

  const runs = payload.runs;
  if (!runs || typeof runs !== "object" || Array.isArray(runs)) {
    output.ok = false;
    output.error = "runs.json missing runs map";
    console.log(args.emitJson ? JSON.stringify(output, null, 2) : "reaper: runs.json missing runs map");
    return 1;
  }

  output.summary.runsScanned = Object.keys(runs).length;

  let sessions: any[] = [];
  try {
    const data = runSessions(ACTIVE_MINUTES);
    sessions = Array.isArray(data.sessions) ? data.sessions : [];
  } catch (e: any) {
    output.ok = false;
    output.error = String(e.message || e);
    console.log(args.emitJson ? JSON.stringify(output, null, 2) : `reaper: ${output.error}`);
    return 1;
  }

  const activeIds = new Set<string>();
  for (const session of sessions) if (session && typeof session === "object") for (const id of collectSessionIds(session)) activeIds.add(id);

  const psqlBin = resolvePsql();
  let changed = false;

  for (const [runKey, run] of Object.entries<any>(runs)) {
    if (!run || typeof run !== "object") continue;

    const status = String(run.status ?? "").trim().toLowerCase();
    if (!STALE_STATUSES.has(status)) continue;

    const startedAt = run.startedAt;
    if (typeof startedAt !== "number") continue;

    const ageMs = now - Math.trunc(startedAt);
    if (ageMs <= maxAgeMs) continue;

    output.summary.staleCandidates += 1;
    const runIds = collectRunIds(run);
    const isActive = Array.from(runIds).some((id) => activeIds.has(id));
    if (isActive) continue;

    const label = run.label;
    const runId = String(run.runId ?? "");
    const childKey = String(run.childSessionKey ?? "");
    const ageHours = Math.round((ageMs / 3600000) * 100) / 100;
    const outcomeText = `Reaped stale sub-agent session ${label || childKey || runId || runKey} after ${ageHours}h without activity.`;

    const entry: any = {
      runKey,
      runId: runId || null,
      childSessionKey: childKey || null,
      label,
      startedAt: isoFromMs(startedAt),
      ageHours,
      endedAt: isoFromMs(now),
    };

    if (!args.dryRun) {
      run.endedAt = now;
      run.endedReason = "reaped_stale";
      run.status = "failed";
      const outcome = run.outcome && typeof run.outcome === "object" ? run.outcome : {};
      outcome.status = "failed";
      run.outcome = outcome;
      runs[runKey] = run;
      changed = true;

      const metadata = {
        run_key: runKey,
        run_id: runId || null,
        child_session_key: childKey || null,
        label,
        started_at: entry.startedAt,
        ended_at: entry.endedAt,
        age_hours: ageHours,
        reason: "reaped_stale",
      };

      const [eventOk, eventErr] = logReapedEvent(psqlBin, metadata, `Sub-agent run reaped: ${label || childKey || runId || runKey}`);
      entry.eventLogged = !!eventOk;
      if (eventOk) output.summary.eventsLogged += 1;
      else if (eventErr) {
        output.summary.errors += 1;
        output.errors.push({ runKey, error: `event_log_failed: ${eventErr}` });
      }

      const [taskOk, taskErr, taskCount] = resetTasks(psqlBin, runId, label, childKey, outcomeText);
      entry.tasksReset = taskCount;
      if (taskOk) output.summary.tasksReset += taskCount;
      else {
        output.summary.errors += 1;
        output.errors.push({ runKey, error: `task_reset_failed: ${taskErr}` });
      }
    } else {
      entry.eventLogged = false;
      entry.tasksReset = 0;
    }

    output.summary.reapedRuns += 1;
    output.reaped.push(entry);
  }

  if (changed && !args.dryRun) writeJsonFileAtomic(RUN_STORE_PATH, payload, 2);

  if (args.emitJson) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    const s = output.summary;
    console.log(`reaper: scanned=${s.runsScanned} stale=${s.staleCandidates} reaped=${s.reapedRuns} tasks_reset=${s.tasksReset} events=${s.eventsLogged} errors=${s.errors}`);
  }

  return output.ok ? 0 : 1;
}

process.exit(main());
