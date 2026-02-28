#!/usr/bin/env npx tsx

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { readJsonFile, writeJsonFileAtomic } from "../lib/json-file.js";
import { resolveRepoPath } from "../lib/paths.js";

const FAIL_STATUSES = new Set(["failed", "error", "aborted", "timeout", "timed_out", "cancelled"]);
const TELEGRAM_GUARD = resolveRepoPath("tools/notifications/telegram-delivery-guard.sh");
const COMPLETION_SYNC = resolveRepoPath("tools/task-board/completion-sync.sh");
const DB_NAME = "cortana";
const RUN_STORE_PATH = process.env.OPENCLAW_SUBAGENT_RUNS_PATH
  ? process.env.OPENCLAW_SUBAGENT_RUNS_PATH
  : path.join(os.homedir(), ".openclaw/subagents/runs.json");

function nowMs(): number {
  return Date.now();
}

function isoFromMs(ms: number | null | undefined): string | null {
  if (!ms) return null;
  return new Date(ms).toISOString();
}

function loadJson<T>(filePath: string, defaultValue: T): T {
  const data = readJsonFile<T>(filePath);
  return data ?? defaultValue;
}

type HeartbeatState = {
  version: number;
  lastChecks: Record<string, unknown>;
  lastRemediationAt: number;
  subagentWatchdog: { lastRun: number; lastLogged: Record<string, number> };
};

function normalizeHeartbeatState(data: unknown): HeartbeatState {
  const base: HeartbeatState = {
    version: 2,
    lastChecks: {},
    lastRemediationAt: 0,
    subagentWatchdog: { lastRun: 0, lastLogged: {} },
  };

  if (!data || typeof data !== "object" || Array.isArray(data)) return base;
  const dict = data as Record<string, unknown>;

  const out: HeartbeatState = { ...base };
  out.version = Number(dict.version ?? base.version);

  if (dict.lastChecks && typeof dict.lastChecks === "object" && !Array.isArray(dict.lastChecks)) {
    out.lastChecks = dict.lastChecks as Record<string, unknown>;
  }

  const sub = dict.subagentWatchdog;
  if (sub && typeof sub === "object" && !Array.isArray(sub)) {
    const s = sub as Record<string, unknown>;
    out.subagentWatchdog = {
      lastRun: Number(s.lastRun ?? 0),
      lastLogged:
        s.lastLogged && typeof s.lastLogged === "object" && !Array.isArray(s.lastLogged)
          ? (s.lastLogged as Record<string, number>)
          : {},
    };
  }

  return out;
}

function saveJsonWithBackup(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const backup = `${filePath}.bak`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backup);
  }
  writeJsonFileAtomic(filePath, data, 2);
}

function emitTerminalToRunStore(
  sessionKey: string,
  sessionId: string,
  label: string | null,
  reasonCode: string,
  reasonDetail: string | null,
  runStorePath = RUN_STORE_PATH
): [boolean, string | null, boolean] {
  const payload = loadJson<Record<string, unknown>>(runStorePath, {});
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [false, "runs.json missing runs object", false];
  }
  const runs = (payload as any).runs;
  if (!runs || typeof runs !== "object" || Array.isArray(runs)) {
    return [false, "runs.json missing runs object", false];
  }

  const session = String(sessionId || "");
  let matchKey: string | null = null;
  for (const [key, record] of Object.entries(runs as Record<string, any>)) {
    if (!record || typeof record !== "object") continue;
    if (session && (String(record.childSessionKey || "") === session || String(record.runId || "") === session)) {
      matchKey = key;
      break;
    }
  }

  if (!matchKey) {
    return [true, null, false];
  }

  const record = (runs as Record<string, any>)[matchKey];
  if (!record || typeof record !== "object") {
    return [false, `invalid run record for ${matchKey}`, false];
  }

  record.endedAt = nowMs();
  record.endedReason = String(reasonCode || "watchdog_terminal");
  const outcome = typeof record.outcome === "object" && record.outcome ? record.outcome : {};
  outcome.status = "failed";
  record.outcome = outcome;

  (runs as Record<string, any>)[matchKey] = record;
  (payload as any).runs = runs;

  saveJsonWithBackup(runStorePath, payload);
  return [true, null, true];
}

function resolvePsql(): string {
  const candidates = [process.env.PSQL_BIN, "/opt/homebrew/opt/postgresql@17/bin/psql", "psql"].filter(Boolean) as string[];
  for (const cand of candidates) {
    if (cand === "psql") {
      const proc = spawnSync("/usr/bin/env", ["bash", "-lc", "command -v psql"], { encoding: "utf8" });
      if (proc.status === 0 && proc.stdout?.trim()) return "psql";
    } else if (fs.existsSync(cand)) {
      return cand;
    }
  }
  return "psql";
}

function runSessions(activeMinutes: number, allAgents: boolean): Record<string, unknown> {
  const cmd = ["openclaw", "sessions", "--json", "--active", String(activeMinutes)];
  if (allAgents) cmd.push("--all-agents");
  const proc = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (proc.status !== 0) {
    throw new Error((proc.stderr || proc.stdout || "openclaw sessions failed").trim());
  }
  try {
    return JSON.parse(proc.stdout || "{}") as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid JSON from openclaw sessions: ${error}`);
  }
}

function isLikelyRunning(session: Record<string, any>): boolean {
  return session.totalTokens == null || session.totalTokensFresh === false;
}

function failureReasons(session: Record<string, any>, maxRuntimeMs: number): Array<Record<string, string>> {
  const reasons: Array<Record<string, string>> = [];
  if (session.abortedLastRun === true) {
    reasons.push({ code: "aborted_last_run", detail: "abortedLastRun=true" });
  }

  const status = String(session.status ?? session.lastStatus ?? "").trim().toLowerCase();
  if (status && FAIL_STATUSES.has(status)) {
    reasons.push({ code: "failed_status", detail: `status=${status}` });
  }

  const ageMs = Number(session.ageMs ?? 0);
  if (ageMs > maxRuntimeMs && isLikelyRunning(session)) {
    reasons.push({ code: "runtime_exceeded", detail: `ageMs=${ageMs} > maxRuntimeMs=${maxRuntimeMs}` });
  }

  return reasons;
}

function sqlQuote(value: string | null | undefined): string {
  return (value ?? "").replace(/'/g, "''");
}

function findTaskIdForSession(opts: { psqlBin: string; sessionKey: string; label: string | null; runId: string | null }): number | null {
  const runQ = sqlQuote(opts.runId ?? "");
  const labelQ = sqlQuote(opts.label ?? "");
  const keyQ = sqlQuote(opts.sessionKey ?? "");

  const sql =
    "SELECT id FROM cortana_tasks " +
    "WHERE status='in_progress' AND ((NULLIF('" +
    runQ +
    "','') <> '' AND run_id='" +
    runQ +
    "') OR (run_id IS NULL AND (assigned_to='" +
    labelQ +
    "' OR assigned_to='" +
    keyQ +
    "' OR COALESCE(metadata->>'subagent_label','')='" +
    labelQ +
    "' OR COALESCE(metadata->>'subagent_session_key','')='" +
    keyQ +
    "'))) " +
    "ORDER BY CASE WHEN NULLIF('" +
    runQ +
    "','') <> '' AND run_id='" +
    runQ +
    "' THEN 0 ELSE 1 END, " +
    "updated_at DESC NULLS LAST, created_at DESC LIMIT 1;";

  const proc = spawnSync(opts.psqlBin, [DB_NAME, "-X", "-t", "-A", "-c", sql], { encoding: "utf8" });
  if (proc.status !== 0) return null;
  const raw = (proc.stdout || "").trim();
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? null : value;
}

function reconcileTaskFailure(reasonItem: Record<string, any>, psqlBin: string): [boolean, string | null, number | null] {
  const taskId = findTaskIdForSession({
    psqlBin,
    sessionKey: String(reasonItem.key ?? ""),
    label: reasonItem.label ?? null,
    runId: reasonItem.runId ?? null,
  });
  if (taskId == null) return [true, null, null];

  const outcome =
    `Watchdog marked failed from sub-agent ${reasonItem.label ?? reasonItem.key} ` +
    `(${reasonItem.reasonCode}: ${reasonItem.reasonDetail})`;
  const outcomeSql = sqlQuote(outcome);
  const runQ = sqlQuote(reasonItem.runId ?? "");
  const reasonQ = sqlQuote(reasonItem.reasonCode ?? "");

  const sql =
    "UPDATE cortana_tasks SET status='failed', outcome='" +
    outcomeSql +
    "', run_id=COALESCE(NULLIF('" +
    runQ +
    "',''), run_id), metadata=COALESCE(metadata,'{}'::jsonb)||" +
    "jsonb_build_object('watchdog_synced_at',NOW()::text,'watchdog_reason','" +
    reasonQ +
    "','subagent_run_id',NULLIF('" +
    runQ +
    "','')) " +
    `WHERE id=${taskId} AND status='in_progress';`;

  const proc = spawnSync(psqlBin, [DB_NAME, "-X", "-c", sql], { encoding: "utf8" });
  if (proc.status !== 0) {
    return [false, (proc.stderr || proc.stdout || "task update failed").trim(), taskId];
  }
  return [true, null, taskId];
}

function logEvent(reasonItem: Record<string, any>, psqlBin: string): [boolean, string | null] {
  const metadata = {
    session_key: reasonItem.key,
    label: reasonItem.label,
    run_id: reasonItem.runId,
    task_id: reasonItem.taskId,
    runtime_seconds: reasonItem.runtimeSeconds,
    failure_reason: reasonItem.reasonCode,
    detail: reasonItem.reasonDetail,
    session_id: reasonItem.sessionId,
    agent_id: reasonItem.agentId,
    status: reasonItem.status,
    detected_at: reasonItem.detectedAt,
  };
  const message = `Sub-agent failure detected: ${reasonItem.key} (${reasonItem.reasonCode}: ${reasonItem.reasonDetail})`;

  const msgSql = sqlQuote(message);
  const metaSql = sqlQuote(JSON.stringify(metadata));
  const sql =
    "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES (" +
    "'subagent_failure', 'subagent-watchdog', 'warning', " +
    `'${msgSql}', '${metaSql}'::jsonb` +
    ");";

  try {
    const proc = spawnSync(psqlBin, [DB_NAME, "-c", sql], { encoding: "utf8" });
    if (proc.status !== 0) {
      return [false, (proc.stderr || proc.stdout || "psql insert failed").trim()];
    }
  } catch {
    return [false, `psql not found (${psqlBin})`];
  }

  return [true, null];
}

function sendFailureAlert(reasonItem: Record<string, any>): [boolean, string | null] {
  if (!fs.existsSync(TELEGRAM_GUARD)) {
    return [false, `telegram guard missing: ${TELEGRAM_GUARD}`];
  }

  const key = reasonItem.key;
  const label = reasonItem.label || "(no label)";
  const reason = reasonItem.reasonCode;
  const detail = reasonItem.reasonDetail;
  const msg = `🚨 Sub-agent failure: ${label}\nSession: ${key}\nReason: ${reason} (${detail})`;

  const proc = spawnSync(TELEGRAM_GUARD, [msg, "8171372724", "", "subagent_failure_alert", `subagent:${key}:${reason}`], { encoding: "utf8" });
  if (proc.status !== 0) {
    return [false, (proc.stderr || proc.stdout || "telegram guard failed").trim()];
  }
  return [true, null];
}

function runCompletionSync(): [boolean, string | null] {
  if (!fs.existsSync(COMPLETION_SYNC)) {
    return [false, `completion sync missing: ${COMPLETION_SYNC}`];
  }
  const proc = spawnSync(COMPLETION_SYNC, { encoding: "utf8" });
  if (proc.status !== 0) {
    return [false, (proc.stderr || proc.stdout || "completion sync failed").trim()];
  }
  return [true, null];
}

type Args = {
  maxRuntimeSeconds: number;
  activeMinutes: number;
  cooldownSeconds: number;
  stateFile: string;
  allAgents: boolean;
  emitTerminal: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    maxRuntimeSeconds: 180,
    activeMinutes: 1440,
    cooldownSeconds: 3600,
    stateFile: path.join(os.homedir(), "openclaw/memory/heartbeat-state.json"),
    allAgents: true,
    emitTerminal: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--max-runtime-seconds" && next) {
      args.maxRuntimeSeconds = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--active-minutes" && next) {
      args.activeMinutes = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--cooldown-seconds" && next) {
      args.cooldownSeconds = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--state-file" && next) {
      args.stateFile = next;
      i += 1;
    } else if (arg === "--all-agents") {
      args.allAgents = true;
    } else if (arg === "--no-all-agents") {
      args.allAgents = false;
    } else if (arg === "--emit-terminal") {
      args.emitTerminal = true;
    } else if (arg === "--no-emit-terminal") {
      args.emitTerminal = false;
    }
  }

  return args;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const now = nowMs();
  const psqlBin = resolvePsql();
  const statePath = args.stateFile;
  const state = normalizeHeartbeatState(loadJson(statePath, {}));
  const watchdogState = state.subagentWatchdog || { lastRun: 0, lastLogged: {} };
  const lastLogged = watchdogState.lastLogged ?? {};

  const output: Record<string, any> = {
    ok: true,
    timestamp: isoFromMs(now),
    config: {
      maxRuntimeSeconds: args.maxRuntimeSeconds,
      activeMinutes: args.activeMinutes,
      cooldownSeconds: args.cooldownSeconds,
      allAgents: args.allAgents,
      emitTerminal: args.emitTerminal,
    },
    summary: {
      sessionsScanned: 0,
      subagentSessionsScanned: 0,
      failedOrTimedOut: 0,
      loggedEvents: 0,
      alertsSent: 0,
      tasksUpdated: 0,
      terminalsEmitted: 0,
      logErrors: 0,
    },
    failedAgents: [],
    logErrors: [],
  };

  let sessions: Array<Record<string, any>> = [];
  try {
    const data = runSessions(args.activeMinutes, args.allAgents);
    sessions = Array.isArray((data as any).sessions) ? (data as any).sessions : [];
  } catch (error) {
    output.ok = false;
    output.error = String(error);
    console.log(JSON.stringify(output, null, 2));
    return 1;
  }

  output.summary.sessionsScanned = sessions.length;

  const findings: Array<Record<string, any>> = [];
  const maxRuntimeMs = args.maxRuntimeSeconds * 1000;

  for (const s of sessions) {
    const key = String(s.key ?? "");
    if (!key.includes(":subagent:")) continue;

    output.summary.subagentSessionsScanned += 1;
    const reasons = failureReasons(s, maxRuntimeMs);
    if (!reasons.length) continue;

    const runtimeSeconds = Math.floor(Number(s.ageMs ?? 0) / 1000);
    const base = {
      key,
      label: s.label,
      runId: s.run_id ?? s.runId ?? s.sessionId,
      sessionId: s.sessionId,
      agentId: s.agentId,
      runtimeSeconds,
      updatedAt: isoFromMs(s.updatedAt),
      status: s.status ?? s.lastStatus,
      abortedLastRun: s.abortedLastRun ?? false,
      detectedAt: isoFromMs(now),
    };

    for (const r of reasons) {
      findings.push({
        ...base,
        reasonCode: r.code,
        reasonDetail: r.detail,
      });
    }
  }

  output.summary.failedOrTimedOut = findings.length;

  const cutoff = now - 24 * 60 * 60 * 1000;
  const prunedLastLogged: Record<string, number> = {};
  for (const [k, v] of Object.entries(lastLogged)) {
    if (typeof v === "number" && v >= cutoff) prunedLastLogged[k] = v;
  }

  for (const item of findings) {
    const signature = `${item.key}|${item.reasonCode}`;
    const recent = prunedLastLogged[signature];
    const inCooldown = typeof recent === "number" && (now - recent) < (args.cooldownSeconds * 1000);

    item.logged = false;
    item.cooldownSkipped = Boolean(inCooldown);

    const [taskOk, taskErr, taskId] = reconcileTaskFailure(item, psqlBin);
    item.taskId = taskId;
    item.taskUpdated = Boolean(taskId != null && taskOk);
    if (item.taskUpdated) {
      output.summary.tasksUpdated += 1;
    } else if (taskErr) {
      output.summary.logErrors += 1;
      output.logErrors.push({ signature: `${signature}|task`, error: `task_update_failed: ${taskErr}` });
    }

    if (inCooldown) {
      if (args.emitTerminal) {
        const [emitOk, emitErr, matched] = emitTerminalToRunStore(
          item.key,
          String(item.sessionId ?? item.runId ?? ""),
          item.label ?? null,
          String(item.reasonCode ?? "watchdog_terminal"),
          item.reasonDetail ?? null
        );
        item.terminalEmitted = Boolean(emitOk && matched);
        item.terminalMatched = Boolean(matched);
        if (emitOk && matched) {
          output.summary.terminalsEmitted += 1;
        } else if (emitErr) {
          output.summary.logErrors += 1;
          output.logErrors.push({ signature: `${signature}|terminal`, error: `terminal_emit_failed: ${emitErr}` });
        }
      }
      output.failedAgents.push(item);
      continue;
    }

    const [ok, err] = logEvent(item, psqlBin);
    if (ok) {
      item.logged = true;
      output.summary.loggedEvents += 1;
      prunedLastLogged[signature] = now;
      const [alertOk, alertErr] = sendFailureAlert(item);
      item.alertSent = Boolean(alertOk);
      if (alertOk) {
        output.summary.alertsSent += 1;
      } else if (alertErr) {
        output.summary.logErrors += 1;
        output.logErrors.push({ signature, error: `alert_send_failed: ${alertErr}` });
      }
    } else {
      output.summary.logErrors += 1;
      output.logErrors.push({ signature, error: err });
    }

    if (args.emitTerminal) {
      const [emitOk, emitErr, matched] = emitTerminalToRunStore(
        item.key,
        String(item.sessionId ?? item.runId ?? ""),
        item.label ?? null,
        String(item.reasonCode ?? "watchdog_terminal"),
        item.reasonDetail ?? null
      );
      item.terminalEmitted = Boolean(emitOk && matched);
      item.terminalMatched = Boolean(matched);
      if (emitOk && matched) {
        output.summary.terminalsEmitted += 1;
      } else if (emitErr) {
        output.summary.logErrors += 1;
        output.logErrors.push({ signature: `${signature}|terminal`, error: `terminal_emit_failed: ${emitErr}` });
      }
    }

    output.failedAgents.push(item);
  }

  state.subagentWatchdog = state.subagentWatchdog || { lastRun: 0, lastLogged: {} };
  state.subagentWatchdog.lastRun = now;
  state.subagentWatchdog.lastLogged = prunedLastLogged;
  saveJsonWithBackup(statePath, state);

  const [syncOk, syncErr] = runCompletionSync();
  output.taskBoardSync = { ok: Boolean(syncOk), error: syncErr };

  console.log(JSON.stringify(output, null, 2));
  return 0;
}

function runPreCheck(): void {
  const validator = resolveRepoPath("tools/heartbeat/validate-heartbeat-state.sh");
  if (fs.existsSync(validator)) {
    spawnSync(validator, { stdio: "ignore" });
  }
}

function runPostChecks(): void {
  const reaper = resolveRepoPath("tools/reaper/reaper.sh");
  const reconciler = resolveRepoPath("tools/session-reconciler/reconcile-sessions.sh");
  if (fs.existsSync(reaper)) {
    spawnSync(reaper, ["--emit-json"], { stdio: "ignore" });
  }
  if (fs.existsSync(reconciler)) {
    spawnSync(reconciler, { stdio: "ignore" });
  }
  if (fs.existsSync(reaper)) {
    spawnSync(reaper, { stdio: "ignore" });
  }
}

runPreCheck();
const exitCode = main();
if (exitCode === 0) {
  runPostChecks();
}
process.exit(exitCode);
