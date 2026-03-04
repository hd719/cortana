#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { readJsonFile, rotateBackupRing, withFileLock, writeJsonFileAtomic } from "../lib/json-file.js";
import {
  defaultHeartbeatState,
  hashHeartbeatState,
  HEARTBEAT_MAX_AGE_MS,
  isHeartbeatQuietHours,
  shouldSendHeartbeatAlert,
  touchHeartbeat,
  validateHeartbeatState,
} from "../lib/heartbeat-schema.js";

const TERMINAL_TIMEOUT_STATUSES = new Set(["timeout", "timed_out"]);
const TERMINAL_KILLED_STATUSES = new Set(["killed", "kill", "terminated", "aborted", "cancelled", "canceled"]);
const TERMINAL_FAILED_STATUSES = new Set(["failed", "error"]);
const FAIL_STATUSES = new Set([
  ...Array.from(TERMINAL_TIMEOUT_STATUSES),
  ...Array.from(TERMINAL_KILLED_STATUSES),
  ...Array.from(TERMINAL_FAILED_STATUSES),
]);
const TELEGRAM_GUARD = "/Users/hd/openclaw/tools/notifications/telegram-delivery-guard.sh";
const COMPLETION_SYNC = "/Users/hd/openclaw/tools/task-board/completion-sync.sh";
const DB_NAME = "cortana";
const DEFAULT_HEARTBEAT_STATE_FILE = path.join(os.homedir(), ".openclaw", "memory", "heartbeat-state.json");
const DEFAULT_SESSION_ALERT_STATE_FILE = "/tmp/subagent-watchdog-cooldown.json";
const SESSION_ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const RUN_STORE_PATH = process.env.OPENCLAW_SUBAGENT_RUNS_PATH
  ? process.env.OPENCLAW_SUBAGENT_RUNS_PATH
  : path.join(os.homedir(), ".openclaw", "subagents", "runs.json");


type JsonMap = Record<string, unknown>;

type SessionSummary = {
  key?: string;
  label?: string | null;
  status?: string;
  lastStatus?: string;
  ageMs?: number;
  totalTokens?: number | null;
  totalTokensFresh?: boolean;
  abortedLastRun?: boolean;
  run_id?: string;
  runId?: string;
  sessionId?: string;
  agentId?: string;
  modelProvider?: string;
  updatedAt?: number;
};

type FailureReason = { code: string; detail: string };

type FailureFinding = {
  key: string;
  label?: string | null;
  runId?: string | null;
  sessionId?: string;
  agentId?: string;
  runtimeSeconds: number;
  updatedAt: string | null;
  status?: string;
  providerStatus?: string | null;
  stopReason?: string | null;
  queueDepth?: number;
  retryOutcome?: string | null;
  abortedLastRun: boolean;
  detectedAt: string | null;
  reasonCode: string;
  reasonDetail: string;
  logged?: boolean;
  cooldownSkipped?: boolean;
  sessionCooldownSkipped?: boolean;
  taskId?: number | null;
  taskUpdated?: boolean;
  alertSent?: boolean;
  terminalEmitted?: boolean;
  terminalMatched?: boolean;
};

function nowMs(): number {
  return Math.trunc(Date.now());
}

function isoFromMs(ms?: number | null): string | null {
  if (!ms) return null;
  return new Date(ms).toISOString();
}

function loadJson<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  const parsed = readJsonFile<unknown>(filePath);
  return (parsed as T | null) ?? fallback;
}

function findRunSnapshot(sessionKey: string, runId: string | null | undefined, sessionId: string | null | undefined): JsonMap | null {
  const payload = loadJson<JsonMap>(RUN_STORE_PATH, {});
  const runs = payload?.runs;
  if (!runs || typeof runs !== "object") return null;

  const runIdStr = String(runId ?? "");
  const sessionIdStr = String(sessionId ?? "");
  const keyStr = String(sessionKey ?? "");
  for (const record of Object.values(runs as Record<string, unknown>)) {
    if (!record || typeof record !== "object") continue;
    const r = record as JsonMap;
    const child = String(r.childSessionKey ?? "");
    const recRunId = String(r.runId ?? "");
    if ((runIdStr && recRunId === runIdStr) || (sessionIdStr && (recRunId === sessionIdStr || child === sessionIdStr)) || (keyStr && child === keyStr)) {
      return r;
    }
  }
  return null;
}

function loadHeartbeatStateStrict(filePath: string, now = Date.now()) {
  const fallback = defaultHeartbeatState(now);
  if (!fs.existsSync(filePath)) return fallback;

  const parsed = readJsonFile<unknown>(filePath);
  try {
    return validateHeartbeatState(parsed, now, HEARTBEAT_MAX_AGE_MS);
  } catch {
    for (const i of [1, 2, 3] as const) {
      const candidate = `${filePath}.bak.${i}`;
      if (!fs.existsSync(candidate)) continue;
      const backupParsed = readJsonFile<unknown>(candidate);
      try {
        return validateHeartbeatState(backupParsed, now, HEARTBEAT_MAX_AGE_MS);
      } catch {
        // try next backup
      }
    }
    return fallback;
  }
}

function normalizeTerminalStatus(rawStatus: string | null | undefined): "timeout" | "killed" | "failed" | null {
  const status = String(rawStatus ?? "").trim().toLowerCase();
  if (!status) return null;
  if (TERMINAL_TIMEOUT_STATUSES.has(status)) return "timeout";
  if (TERMINAL_KILLED_STATUSES.has(status)) return "killed";
  if (TERMINAL_FAILED_STATUSES.has(status)) return "failed";
  return null;
}

function terminalStatusFromReason(item: FailureFinding): string {
  const code = String(item.reasonCode ?? "").toLowerCase();
  const byStatus = normalizeTerminalStatus(item.status);
  if (byStatus) return byStatus;
  if (code === "runtime_exceeded" || code === "timeout_status") return "timeout";
  if (code === "killed_status" || code === "aborted_last_run") return "killed";
  return "failed";
}

function emitTerminalToRunStore(
  sessionKey: string,
  sessionId: string,
  runId: string,
  label: string | null,
  reasonCode: string,
  reasonDetail: string | null,
  status: string | null
): [boolean, string | null, boolean] {
  let payload = loadJson(RUN_STORE_PATH, {});
  if (!payload || typeof payload !== "object") payload = {};

  const runs = payload.runs;
  if (!runs || typeof runs !== "object") return [false, "runs.json missing runs object", false];

  const sessionIdStr = String(sessionId || "");
  const runIdStr = String(runId || "");
  const sessionKeyStr = String(sessionKey || "");
  let matchKey: string | null = null;
  for (const [key, record] of Object.entries(runs)) {
    if (!record || typeof record !== "object") continue;
    if (
      (sessionKeyStr && String((record as JsonMap).childSessionKey ?? "") === sessionKeyStr) ||
      (sessionIdStr &&
        (String((record as JsonMap).childSessionKey ?? "") === sessionIdStr ||
          String((record as JsonMap).runId ?? "") === sessionIdStr)) ||
      (runIdStr && String((record as JsonMap).runId ?? "") === runIdStr)
    ) {
      matchKey = key;
      break;
    }
  }

  if (!matchKey) return [true, null, false];
  const record = (runs as Record<string, JsonMap>)[matchKey];
  if (!record || typeof record !== "object") return [false, `invalid run record for ${matchKey}`, false];

  const nextStatus = terminalStatusFromReason({ reasonCode, status } as FailureFinding);
  const currentOutcome = record.outcome && typeof record.outcome === "object" ? (record.outcome as JsonMap) : {};
  const alreadyEnded = Number(record.endedAt ?? 0) > 0;
  const sameStatus = String(currentOutcome.status ?? "") === nextStatus;
  const sameReason = String(record.endedReason ?? "") === String(reasonCode || "watchdog_terminal");
  if (alreadyEnded && (sameStatus || sameReason)) return [true, null, false];

  record.endedAt = nowMs();
  record.endedReason = String(reasonCode || "watchdog_terminal");
  const outcome = currentOutcome;
  outcome.status = nextStatus;
  outcome.detail = reasonDetail ?? null;
  record.outcome = outcome;
  (runs as Record<string, JsonMap>)[matchKey] = record;

  writeJsonFileAtomic(RUN_STORE_PATH, payload, 2);
  return [true, null, true];
}

function resolvePsql(): string {
  const candidates = [process.env.PSQL_BIN, "/opt/homebrew/opt/postgresql@17/bin/psql", "psql"].filter(
    Boolean
  ) as string[];
  for (const c of candidates) {
    if (c === "psql") {
      const proc = spawnSync("/usr/bin/env", ["bash", "-lc", "command -v psql"], { encoding: "utf8" });
      if (proc.status === 0 && (proc.stdout ?? "").trim()) return "psql";
      continue;
    }
    if (fs.existsSync(c)) return c;
  }
  return "psql";
}

function runSessions(activeMinutes: number | null, allAgents: boolean): JsonMap {
  const cmd = ["openclaw", "sessions", "--json"];
  if (typeof activeMinutes === "number" && Number.isFinite(activeMinutes) && activeMinutes > 0) {
    cmd.push("--active", String(activeMinutes));
  }
  if (allAgents) cmd.push("--all-agents");
  const proc = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (proc.status !== 0) {
    const msg = (proc.stderr ?? proc.stdout ?? "openclaw sessions failed").trim();
    throw new Error(msg);
  }
  try {
    return JSON.parse(proc.stdout ?? "");
  } catch (err) {
    throw new Error(`Invalid JSON from openclaw sessions: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isLikelyRunning(session: SessionSummary): boolean {
  return session.totalTokens == null || session.totalTokensFresh === false;
}

function failureReasons(session: SessionSummary, maxRuntimeMs: number): FailureReason[] {
  const reasons: FailureReason[] = [];
  if (session.abortedLastRun === true) reasons.push({ code: "aborted_last_run", detail: "abortedLastRun=true" });

  const status = String(session.status ?? session.lastStatus ?? "").trim().toLowerCase();
  if (status && FAIL_STATUSES.has(status)) {
    const terminalStatus = normalizeTerminalStatus(status);
    if (terminalStatus === "timeout") reasons.push({ code: "timeout_status", detail: `status=${status}` });
    else if (terminalStatus === "killed") reasons.push({ code: "killed_status", detail: `status=${status}` });
    else reasons.push({ code: "failed_status", detail: `status=${status}` });
  }

  const ageMs = Number(session.ageMs ?? 0);
  if (ageMs > maxRuntimeMs && isLikelyRunning(session)) {
    reasons.push({
      code: "runtime_exceeded",
      detail: `ageMs=${ageMs} > maxRuntimeMs=${maxRuntimeMs}`,
    });
  }

  return reasons;
}

function sqlQuote(value: string | null): string {
  return (value || "").replace(/'/g, "''");
}

function logHeartbeatWrite(psqlBin: string, oldHash: string | null, newHash: string): void {
  const metaSql = JSON.stringify({ old_hash: oldHash, new_hash: newHash }).replace(/'/g, "''");
  const sql =
    "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES (" +
    "'heartbeat_state_write','subagent-watchdog','info','Heartbeat state updated by subagent watchdog','" +
    metaSql +
    "'::jsonb);";
  spawnSync(psqlBin, [DB_NAME, "-c", sql], { encoding: "utf8" });
}

function findTaskIdForSession(psqlBin: string, sessionKey: string, label: string | null, runId: string | null):
  | number
  | null {
  const runQ = sqlQuote(runId);
  const labelQ = sqlQuote(label);
  const keyQ = sqlQuote(sessionKey);
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

  const proc = spawnSync(psqlBin, [DB_NAME, "-X", "-t", "-A", "-c", sql], { encoding: "utf8" });
  if (proc.status !== 0) return null;
  const raw = (proc.stdout ?? "").trim();
  if (!raw) return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

function reconcileTaskFailure(reasonItem: FailureFinding, psqlBin: string): [boolean, string | null, number | null] {
  const taskId = findTaskIdForSession(
    psqlBin,
    String(reasonItem.key ?? ""),
    reasonItem.label ?? null,
    reasonItem.runId ?? null
  );
  if (taskId == null) return [true, null, null];

  const terminalStatus = terminalStatusFromReason(reasonItem);
  const outcome =
    `Watchdog marked failed from sub-agent ${reasonItem.label ?? reasonItem.key} ` +
    `(${terminalStatus}; ${reasonItem.reasonCode}: ${reasonItem.reasonDetail})`;
  const outcomeSql = sqlQuote(outcome);
  const runQ = sqlQuote(reasonItem.runId ?? null);
  const reasonQ = sqlQuote(reasonItem.reasonCode ?? null);
  const terminalQ = sqlQuote(terminalStatus);
  const sql =
    "UPDATE cortana_tasks SET status='failed', outcome='" +
    outcomeSql +
    "', run_id=COALESCE(NULLIF('" +
    runQ +
    "',''), run_id), metadata=COALESCE(metadata,'{}'::jsonb)||" +
    "jsonb_build_object('watchdog_synced_at',NOW()::text,'watchdog_reason','" +
    reasonQ +
    "','watchdog_terminal_status','" +
    terminalQ +
    "','subagent_run_id',NULLIF('" +
    runQ +
    "','')) " +
    `WHERE id=${taskId} AND status='in_progress';`;

  const proc = spawnSync(psqlBin, [DB_NAME, "-X", "-c", sql], { encoding: "utf8" });
  if (proc.status !== 0) {
    return [false, (proc.stderr ?? proc.stdout ?? "task update failed").trim(), taskId];
  }
  return [true, null, taskId];
}

function logEvent(reasonItem: FailureFinding, psqlBin: string): [boolean, string | null] {
  const terminalStatus = terminalStatusFromReason(reasonItem);
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
    terminal_status: terminalStatus,
    stop_reason: reasonItem.stopReason ?? reasonItem.reasonCode,
    provider_status: reasonItem.providerStatus ?? reasonItem.status ?? null,
    queue_depth: reasonItem.queueDepth ?? null,
    retry_outcome: reasonItem.retryOutcome ?? null,
    detected_at: reasonItem.detectedAt,
  };
  const message = `Sub-agent failure detected: ${reasonItem.key} (${reasonItem.reasonCode}: ${reasonItem.reasonDetail})`;
  const msgSql = message.replace(/'/g, "''");
  const metaSql = JSON.stringify(metadata).replace(/'/g, "''");
  const sql =
    "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES (" +
    "'subagent_failure', 'subagent-watchdog', 'warning', " +
    `'${msgSql}', '${metaSql}'::jsonb` +
    ");";

  try {
    const proc = spawnSync(psqlBin, [DB_NAME, "-c", sql], { encoding: "utf8" });
    if (proc.status !== 0) return [false, (proc.stderr ?? proc.stdout ?? "psql insert failed").trim()];
    return [true, null];
  } catch {
    return [false, `psql not found (${psqlBin})`];
  }
}

function sendFailureAlert(reasonItem: FailureFinding, now = new Date()): [boolean, string | null] {
  const terminalStatus = terminalStatusFromReason(reasonItem);
  const isUrgent = terminalStatus === "failed";
  if (!shouldSendHeartbeatAlert(isUrgent, now)) {
    return [true, "suppressed_during_quiet_hours"];
  }

  if (!fs.existsSync(TELEGRAM_GUARD)) return [false, `telegram guard missing: ${TELEGRAM_GUARD}`];

  const key = reasonItem.key;
  const label = reasonItem.label ?? "(no label)";
  const reason = reasonItem.reasonCode;
  const detail = reasonItem.reasonDetail;
  const msg = `🚨 Sub-agent failure: ${label}\nSession: ${key}\nTerminal: ${terminalStatus}\nReason: ${reason} (${detail})`;

  const proc = spawnSync(TELEGRAM_GUARD, [msg, "8171372724", "", "subagent_failure_alert", `subagent:${key}:${reason}`], {
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    return [false, (proc.stderr ?? proc.stdout ?? "telegram guard failed").trim()];
  }
  return [true, null];
}

function runCompletionSync(): [boolean, string | null] {
  if (!fs.existsSync(COMPLETION_SYNC)) return [false, `completion sync missing: ${COMPLETION_SYNC}`];
  const proc = spawnSync(COMPLETION_SYNC, [], { encoding: "utf8" });
  if (proc.status !== 0) return [false, (proc.stderr ?? proc.stdout ?? "completion sync failed").trim()];
  return [true, null];
}

type Args = {
  maxRuntimeSeconds: number;
  activeMinutes: number;
  cooldownSeconds: number;
  stateFile: string;
  allAgents: boolean;
  emitTerminal: boolean;
  staleFailureWindowSeconds: number;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    maxRuntimeSeconds: 600,
    activeMinutes: 1440,
    cooldownSeconds: 3600,
    stateFile: DEFAULT_HEARTBEAT_STATE_FILE,
    allAgents: true,
    emitTerminal: true,
    staleFailureWindowSeconds: 15 * 60,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--max-runtime-seconds":
        args.maxRuntimeSeconds = Number(argv[i + 1]);
        i += 1;
        break;
      case "--active-minutes":
        args.activeMinutes = Number(argv[i + 1]);
        i += 1;
        break;
      case "--cooldown-seconds":
        args.cooldownSeconds = Number(argv[i + 1]);
        i += 1;
        break;
      case "--state-file":
        args.stateFile = argv[i + 1] ?? args.stateFile;
        i += 1;
        break;
      case "--all-agents":
        args.allAgents = true;
        break;
      case "--no-all-agents":
        args.allAgents = false;
        break;
      case "--emit-terminal":
        args.emitTerminal = true;
        break;
      case "--no-emit-terminal":
        args.emitTerminal = false;
        break;
      case "--stale-failure-window-seconds":
        args.staleFailureWindowSeconds = Number(argv[i + 1]);
        i += 1;
        break;
      default:
        break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const now = nowMs();
  const psqlBin = resolvePsql();
  const statePath = args.stateFile;
  const sessionAlertStatePath =
    process.env.SUBAGENT_WATCHDOG_SESSION_ALERT_STATE_FILE ?? DEFAULT_SESSION_ALERT_STATE_FILE;
  let state;
  try {
    state = withFileLock(statePath, 5000, () => loadHeartbeatStateStrict(statePath, now));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[subagent-watchdog] lock/read failed: ${msg}`);
    process.exit(1);
  }
  const watchdogState = state.subagentWatchdog ?? {};
  const lastLogged: Record<string, number> =
    watchdogState.lastLogged && typeof watchdogState.lastLogged === "object" ? watchdogState.lastLogged : {};

  const output: JsonMap = {
    ok: true,
    timestamp: isoFromMs(now),
    quietHours: isHeartbeatQuietHours(new Date(now)),
    config: {
      maxRuntimeSeconds: args.maxRuntimeSeconds,
      activeMinutes: args.activeMinutes,
      cooldownSeconds: args.cooldownSeconds,
      allAgents: args.allAgents,
      emitTerminal: args.emitTerminal,
      staleFailureWindowSeconds: args.staleFailureWindowSeconds,
      sessionAlertCooldownSeconds: Math.trunc(SESSION_ALERT_COOLDOWN_MS / 1000),
    },
    summary: {
      sessionsScanned: 0,
      subagentSessionsScanned: 0,
      sessionsActive: 0,
      sessionsHistorical: 0,
      sessionsTotal: 0,
      sessionsFreshnessMinutes: args.activeMinutes,
      sessionsCountSource: "all_sessions",
      failedOrTimedOut: 0,
      loggedEvents: 0,
      alertsSent: 0,
      tasksUpdated: 0,
      terminalsEmitted: 0,
      staleFailuresSkipped: 0,
      sessionCooldownSkipped: 0,
      logErrors: 0,
    },
    failedAgents: [],
    logErrors: [],
  };

  let sessionAlertStateRaw: Record<string, number> = {};
  try {
    sessionAlertStateRaw = withFileLock(sessionAlertStatePath, 5000, () => {
      const parsed = loadJson<unknown>(sessionAlertStatePath, {});
      if (!parsed || typeof parsed !== "object") return {};
      const entries = Object.entries(parsed as Record<string, unknown>).filter(
        ([, value]) => typeof value === "number" && Number.isFinite(value)
      );
      return Object.fromEntries(entries) as Record<string, number>;
    });
  } catch (err) {
    output.summary.logErrors += 1;
    output.logErrors.push({
      signature: "session_alert_state_load",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let data: JsonMap;
  try {
    data = runSessions(args.activeMinutes, args.allAgents);
  } catch (err) {
    output.ok = false;
    output.error = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify(output, null, 2));
    process.exit(1);
  }

  const sessions: SessionSummary[] = Array.isArray(data.sessions) ? (data.sessions as SessionSummary[]) : [];
  output.summary.sessionsScanned = sessions.length;
  output.summary.sessionsActive = sessions.length;

  let totalSessions: SessionSummary[] | null = null;
  try {
    const totalData = runSessions(null, args.allAgents);
    totalSessions = Array.isArray(totalData.sessions) ? (totalData.sessions as SessionSummary[]) : [];
  } catch (err) {
    output.summary.sessionsCountSource = "active_only";
    output.summary.logErrors += 1;
    output.logErrors.push({
      signature: "sessions_total",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (totalSessions) {
    output.summary.sessionsTotal = totalSessions.length;
    output.summary.sessionsHistorical = Math.max(0, totalSessions.length - sessions.length);
  } else {
    output.summary.sessionsTotal = sessions.length;
    output.summary.sessionsHistorical = 0;
  }

  const findings: FailureFinding[] = [];
  const maxRuntimeMs = args.maxRuntimeSeconds * 1000;
  const totalSubagentSessions = sessions.filter((s) => String(s.key ?? "").includes(":subagent:")).length;

  for (const s of sessions) {
    const key = String(s.key ?? "");
    if (!key.includes(":subagent:")) continue;
    output.summary.subagentSessionsScanned += 1;
    const reasons = failureReasons(s, maxRuntimeMs);
    if (!reasons.length) continue;

    const updatedAtMs = Number(s.updatedAt ?? now);
    const staleMs = args.staleFailureWindowSeconds * 1000;
    const isFailureStale =
      Number.isFinite(updatedAtMs) &&
      updatedAtMs > 0 &&
      staleMs > 0 &&
      now - updatedAtMs > staleMs &&
      !isLikelyRunning(s);
    if (isFailureStale) {
      output.summary.staleFailuresSkipped += reasons.length;
      continue;
    }

    const runtimeSeconds = Math.trunc(Number(s.ageMs ?? 0) / 1000);
    const derivedRunId = s.run_id ?? s.runId ?? s.sessionId;
    const runSnapshot = findRunSnapshot(key, derivedRunId, s.sessionId);
    const snapshotStopReason = typeof runSnapshot?.endedReason === "string" ? String(runSnapshot.endedReason) : null;
    const snapshotProviderStatus =
      typeof runSnapshot?.outcome === "object" && runSnapshot.outcome
        ? String((runSnapshot.outcome as JsonMap).status ?? "") || null
        : null;
    const base = {
      key,
      label: s.label,
      runId: derivedRunId,
      sessionId: s.sessionId,
      agentId: s.agentId,
      runtimeSeconds,
      updatedAt: isoFromMs(s.updatedAt),
      status: s.status ?? s.lastStatus,
      providerStatus: snapshotProviderStatus ?? s.status ?? s.lastStatus ?? null,
      stopReason: snapshotStopReason,
      queueDepth: totalSubagentSessions,
      retryOutcome: null,
      abortedLastRun: s.abortedLastRun ?? false,
      detectedAt: isoFromMs(now),
    };

    for (const r of reasons) {
      findings.push({ ...base, reasonCode: r.code, reasonDetail: r.detail });
    }
  }

  output.summary.failedOrTimedOut = findings.length;

  const cutoff = now - 24 * 60 * 60 * 1000;
  const prunedLastLogged: Record<string, number> = {};
  for (const [k, v] of Object.entries(lastLogged)) {
    if (typeof v === "number" && v >= cutoff) prunedLastLogged[k] = v;
  }
  const prunedSessionAlerts: Record<string, number> = {};
  for (const [k, v] of Object.entries(sessionAlertStateRaw)) {
    if (typeof v === "number" && v >= cutoff) prunedSessionAlerts[k] = v;
  }

  for (const item of findings) {
    const signature = `${item.key}|${item.reasonCode}`;
    const recent = prunedLastLogged[signature];
    const inReasonCooldown = typeof recent === "number" && now - recent < args.cooldownSeconds * 1000;
    const sessionRecent = prunedSessionAlerts[item.key];
    const inSessionCooldown = typeof sessionRecent === "number" && now - sessionRecent < SESSION_ALERT_COOLDOWN_MS;
    const inCooldown = inReasonCooldown || inSessionCooldown;

    item.logged = false;
    item.cooldownSkipped = Boolean(inCooldown);
    item.sessionCooldownSkipped = Boolean(inSessionCooldown);
    if (inSessionCooldown) output.summary.sessionCooldownSkipped += 1;

    const [taskOk, taskErr, taskId] = reconcileTaskFailure(item, psqlBin);
    item.taskId = taskId;
    item.taskUpdated = taskId != null && taskOk;
    if (item.taskUpdated) output.summary.tasksUpdated += 1;
    else if (taskErr) {
      output.summary.logErrors += 1;
      output.logErrors.push({ signature: `${signature}|task`, error: `task_update_failed: ${taskErr}` });
    }

    if (inCooldown) {
      item.retryOutcome = inSessionCooldown ? "suppressed_session_cooldown" : "suppressed_reason_cooldown";
      if (args.emitTerminal) {
        const [emitOk, emitErr, matched] = emitTerminalToRunStore(
          item.key,
          String(item.sessionId ?? item.runId ?? ""),
          String(item.runId ?? ""),
          item.label ?? null,
          String(item.reasonCode ?? "watchdog_terminal"),
          item.reasonDetail,
          item.status ?? null
        );
        item.terminalEmitted = Boolean(emitOk && matched);
        item.terminalMatched = Boolean(matched);
        if (emitOk && matched) output.summary.terminalsEmitted += 1;
        else if (emitErr) {
          output.summary.logErrors += 1;
          output.logErrors.push({ signature: `${signature}|terminal`, error: `terminal_emit_failed: ${emitErr}` });
        }
      }
      output.failedAgents.push(item);
      continue;
    }

    const [ok, err] = logEvent(item, psqlBin);
    if (ok) {
      item.retryOutcome = "logged";
      item.logged = true;
      output.summary.loggedEvents += 1;
      prunedLastLogged[signature] = now;
      prunedSessionAlerts[item.key] = now;
      const [alertOk, alertErr] = sendFailureAlert(item);
      item.alertSent = Boolean(alertOk);
      if (alertOk) output.summary.alertsSent += 1;
      else if (alertErr) {
        output.summary.logErrors += 1;
        output.logErrors.push({ signature, error: `alert_send_failed: ${alertErr}` });
      }
    } else {
      item.retryOutcome = "log_insert_failed";
      output.summary.logErrors += 1;
      output.logErrors.push({ signature, error: err });
    }

    if (args.emitTerminal) {
      const [emitOk, emitErr, matched] = emitTerminalToRunStore(
        item.key,
        String(item.sessionId ?? item.runId ?? ""),
        String(item.runId ?? ""),
        item.label ?? null,
        String(item.reasonCode ?? "watchdog_terminal"),
        item.reasonDetail,
        item.status ?? null
      );
      item.terminalEmitted = Boolean(emitOk && matched);
      item.terminalMatched = Boolean(matched);
      if (emitOk && matched) output.summary.terminalsEmitted += 1;
      else if (emitErr) {
        output.summary.logErrors += 1;
        output.logErrors.push({ signature: `${signature}|terminal`, error: `terminal_emit_failed: ${emitErr}` });
      }
    }

    output.failedAgents.push(item);
  }

  try {
    withFileLock(statePath, 5000, () => {
      const current = loadHeartbeatStateStrict(statePath, now);
      const oldHash = hashHeartbeatState(current);
      current.subagentWatchdog = current.subagentWatchdog ?? { lastRun: now, lastLogged: {} };
      current.subagentWatchdog.lastRun = now;
      current.subagentWatchdog.lastLogged = prunedLastLogged;
      touchHeartbeat(current, now);
      validateHeartbeatState(current, now, HEARTBEAT_MAX_AGE_MS);
      rotateBackupRing(statePath, 3);
      writeJsonFileAtomic(statePath, current, 2);
      logHeartbeatWrite(psqlBin, oldHash, hashHeartbeatState(current));
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[subagent-watchdog] lock/write failed: ${msg}`);
    process.exit(1);
  }

  try {
    withFileLock(sessionAlertStatePath, 5000, () => {
      rotateBackupRing(sessionAlertStatePath, 2);
      writeJsonFileAtomic(sessionAlertStatePath, prunedSessionAlerts, 2);
    });
  } catch (err) {
    output.summary.logErrors += 1;
    output.logErrors.push({
      signature: "session_alert_state_write",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const [syncOk, syncErr] = runCompletionSync();
  output.taskBoardSync = { ok: Boolean(syncOk), error: syncErr };

  console.log(JSON.stringify(output, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
