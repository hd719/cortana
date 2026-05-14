#!/usr/bin/env npx tsx

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPsql } from "../lib/db.js";

type SessionRecord = Record<string, unknown>;
type CovenantRun = {
  id: number;
  agent: string | null;
  mission: string | null;
  session_key: string | null;
  started_at: string | null;
};

function isDryRun(argv: string[]): boolean {
  return argv.includes("--dry-run");
}

function defaultSessionsPath(): string {
  return process.env.OPENCLAW_SESSIONS_FILE ?? path.join(os.homedir(), ".openclaw", "agents", "main", "sessions", "sessions.json");
}

function quoteSql(value: string): string {
  return value.replace(/'/g, "''");
}

function hasPositiveCompletionEvidence(session: SessionRecord): boolean {
  const directStatus = String(session.status ?? "").trim().toLowerCase();
  if (["completed", "done", "success", "succeeded", "ok"].includes(directStatus)) return true;

  const outcome = session.outcome;
  if (outcome && typeof outcome === "object") {
    const outcomeStatus = String((outcome as SessionRecord).status ?? "").trim().toLowerCase();
    if (["completed", "done", "success", "succeeded", "ok"].includes(outcomeStatus)) return true;
  }

  const result = session.result;
  if (result !== undefined && result !== null && result !== "") return true;
  return session.done === true;
}

function loadSessions(filePath: string): Record<string, SessionRecord> {
  if (!fs.existsSync(filePath)) throw new Error(`sessions file missing: ${filePath}`);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("sessions.json is not an object map");
  }
  return parsed as Record<string, SessionRecord>;
}

function reconcileSessionFileState(sessionsPath: string, sessions: Record<string, SessionRecord>, dryRun: boolean): string[] {
  const missing: string[] = [];
  let changed = false;

  for (const [key, session] of Object.entries(sessions)) {
    const sessionFile = typeof session.sessionFile === "string" ? session.sessionFile : "";
    if (!sessionFile || fs.existsSync(sessionFile)) continue;

    missing.push(key);
    if (hasPositiveCompletionEvidence(session)) {
      session.status = "completed";
      session.reconciledReason = "session_file_missing_but_completion_evidence_present";
    } else {
      session.status = "reconciled_unknown";
      session.reconciledReason = "session_disappeared_outcome_unknown";
    }
    session.reconciledAt = Date.now();
    changed = true;
  }

  if (changed && !dryRun) {
    const backupPath = `${sessionsPath}.bak`;
    const tmpPath = `${sessionsPath}.tmp`;
    fs.copyFileSync(sessionsPath, backupPath);
    fs.writeFileSync(tmpPath, `${JSON.stringify(sessions, null, 2)}\n`);
    fs.renameSync(tmpPath, sessionsPath);
  }

  return missing;
}

function psqlText(sql: string): string {
  const proc = runPsql(sql, { db: "cortana" });
  if (proc.status !== 0) {
    throw new Error((proc.stderr || proc.stdout || "psql failed").trim());
  }
  return String(proc.stdout ?? "").trim();
}

function psqlJson<T>(sql: string): T {
  const raw = psqlText(sql);
  return JSON.parse(raw || "null") as T;
}

function fetchOpenRuns(): CovenantRun[] {
  return psqlJson<CovenantRun[]>(`
SELECT COALESCE(json_agg(t), '[]'::json)::text
FROM (
  SELECT id, agent, mission, session_key, started_at
  FROM cortana_covenant_runs
  WHERE (status = 'running' OR ended_at IS NULL)
  ORDER BY started_at ASC
) t;
`);
}

function markRunsReconciled(orphans: CovenantRun[]): void {
  if (orphans.length === 0) return;
  const ids = orphans.map((run) => Number(run.id)).filter(Number.isFinite);
  if (ids.length === 0) return;

  psqlText(`
UPDATE cortana_covenant_runs
SET status = 'reconciled_unknown',
    ended_at = COALESCE(ended_at, NOW()),
    summary = COALESCE(summary, '') ||
      CASE WHEN COALESCE(summary, '') = '' THEN '' ELSE E'\n' END ||
      '[auto-reconciled] session disappeared, outcome unknown (no active session key)'
WHERE id IN (${ids.join(",")});
`);
}

function emitRunEvent(run: CovenantRun): boolean {
  const sessionKey = String(run.session_key ?? "").trim();
  if (!sessionKey) return false;

  const metadata = JSON.stringify({
    session_key: sessionKey,
    agent: run.agent,
    mission: run.mission,
    covenant_run_id: run.id,
    reason: "session_disappeared_outcome_unknown",
  }).replace(/'/g, "''");

  try {
    psqlText(`
INSERT INTO cortana_run_events (run_id, event_type, source, metadata)
VALUES (
  '${quoteSql(sessionKey)}',
  'reconciled_unknown',
  'session-reconciler',
  '${metadata}'::jsonb
);
`);
    return true;
  } catch {
    return false;
  }
}

export async function main(): Promise<void> {
  const dryRun = isDryRun(process.argv.slice(2));
  const sessionsPath = defaultSessionsPath();
  const sessions = loadSessions(sessionsPath);
  const activeKeys = new Set(Object.keys(sessions));
  const sessionOrphans = reconcileSessionFileState(sessionsPath, sessions, dryRun);

  const runOrphans = fetchOpenRuns().filter((run) => {
    const sessionKey = String(run.session_key ?? "");
    return !sessionKey || !activeKeys.has(sessionKey);
  });

  let runEventsEmitted = 0;
  if (!dryRun && runOrphans.length > 0) {
    markRunsReconciled(runOrphans);
    for (const run of runOrphans) {
      if (emitRunEvent(run)) runEventsEmitted += 1;
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dry_run: dryRun,
    sessions_reconciled: sessionOrphans.length,
    session_orphans: sessionOrphans.slice(0, 50),
    runs_reconciled_unknown: dryRun ? 0 : runOrphans.length,
    run_events_emitted: runEventsEmitted,
    run_orphans: runOrphans.slice(0, 50),
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
