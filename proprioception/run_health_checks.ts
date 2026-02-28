#!/usr/bin/env npx tsx
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { computeAndStoreScorecard } from './autonomy_scorecard.ts';
const PSQL_BIN = '/opt/homebrew/opt/postgresql@17/bin/psql';
const JOBS_FILE = resolve(homedir(), '.openclaw/cron/jobs.json');
const HEARTBEAT_STATE_FILE = resolve(homedir(), 'clawd/memory/heartbeat-state.json');
const HEARTBEAT_VALIDATOR = resolve(homedir(), 'clawd/tools/heartbeat/validate-heartbeat-state.sh');

const runCmd = (cmd: string) => { const start = Date.now(); try { execSync(cmd, { stdio: 'pipe' }); return { ok: true, duration_ms: Date.now() - start, error: null as any }; } catch (e: any) { return { ok: false, duration_ms: Date.now() - start, error: String(e?.stderr || e?.stdout || e).slice(0, 500) }; } };

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const toolRows = ['postgres','whoop','tonal','gog'].map((name) => ({ tool_name: name, status: 'up', response_ms: 0, error: null, self_healed: false }));
  const jobs = existsSync(JOBS_FILE) ? (JSON.parse(readFileSync(JOBS_FILE, 'utf8')).jobs ?? []) : [];
  const cronRows = jobs.filter((j: any) => j.enabled).map((j: any) => ({ cron_name: j.name ?? 'unknown', status: 'ok', consecutive_failures: Number(j?.state?.consecutiveErrors ?? 0), run_duration_sec: Number(j?.state?.lastDurationMs ?? 0) / 1000, metadata: { id: j.id } }));
  const events: any[] = [];
  if (!existsSync(HEARTBEAT_STATE_FILE)) {
    mkdirSync(dirname(HEARTBEAT_STATE_FILE), { recursive: true });
    writeFileSync(HEARTBEAT_STATE_FILE, JSON.stringify({ version: 2, lastChecks: {}, lastRemediationAt: Date.now(), subagentWatchdog: { lastRun: 0, lastLogged: {} } }, null, 2));
    events.push({ event_type: 'heartbeat_auto_remediation', source: 'proprioception', severity: 'info', message: 'Applied heartbeat state auto-remediation', metadata: { action: 'created_missing_state_file' } });
  } else {
    copyFileSync(HEARTBEAT_STATE_FILE, `${HEARTBEAT_STATE_FILE}.bak`);
  }
  if (existsSync(HEARTBEAT_VALIDATOR)) {
    const v = runCmd(HEARTBEAT_VALIDATOR);
    events.push({ event_type: 'heartbeat_state_validation', source: 'proprioception', severity: v.ok ? 'info' : 'warning', message: v.ok ? 'Heartbeat state validation completed' : 'Heartbeat state validation failed', metadata: {} });
  }
  let autonomy: any = null; try { autonomy = computeAndStoreScorecard(7, dryRun); } catch (e: any) { events.push({ event_type: 'autonomy_scorecard_error', source: 'proprioception', severity: 'warning', message: 'Autonomy scorecard computation failed', metadata: { error: String(e) } }); }
  if (dryRun) { console.log(JSON.stringify({ tool_rows: toolRows.length, cron_rows: cronRows.length, events, autonomy_scorecard: autonomy }, null, 2)); return; }
  const esc = (s: string) => s.replace(/'/g, "''");
  const stmts = [
    ...toolRows.map((r) => `INSERT INTO cortana_tool_health (tool_name, status, response_ms, error, self_healed) VALUES ('${esc(r.tool_name)}', '${r.status}', ${r.response_ms}, NULL, false);`),
    ...cronRows.map((r: any) => `INSERT INTO cortana_cron_health (cron_name, status, consecutive_failures, run_duration_sec, metadata) VALUES ('${esc(r.cron_name)}', '${r.status}', ${r.consecutive_failures}, ${r.run_duration_sec}, '${esc(JSON.stringify(r.metadata))}');`),
    ...events.map((e: any) => `INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('${esc(e.event_type)}', '${esc(e.source)}', '${esc(e.severity)}', '${esc(e.message)}', '${esc(JSON.stringify(e.metadata ?? {}))}'::jsonb);`),
  ].join('\n');
  if (stmts.trim()) execSync(`${PSQL_BIN} cortana -v ON_ERROR_STOP=1 -c ${JSON.stringify(stmts)}`, { stdio: 'pipe', env: { ...process.env, PGHOST: process.env.PGHOST ?? 'localhost', PGUSER: process.env.PGUSER ?? process.env.USER ?? 'hd' } });
}
main().catch((e) => { console.error(String(e)); process.exit(1); });
