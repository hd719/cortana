#!/usr/bin/env npx tsx
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const SESSION_DIR = join(homedir(), '.openclaw/agents/main/sessions');
const OUTPUT_PATH = '/tmp/efficiency_analysis.json';
const PSQL_BIN = '/opt/homebrew/opt/postgresql@17/bin/psql';
const COST_PER_KB = 0.015;

const roundMoney = (v: number) => Math.round((v + 1e-12) * 10000) / 10000;
const safeReadFirstLine = (p: string) => { try { return (readFileSync(p, 'utf8').split('\n')[0] ?? '').trim(); } catch { return ''; } };

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...walk(p));
    else if (name.isFile() && p.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function runPsql(sql: string): [boolean, string] {
  try { return [true, execFileSync(PSQL_BIN, ['cortana', '-t', '-A', '-c', sql], { encoding: 'utf8', timeout: 3000 }).trim()]; } catch (e: any) { return [false, String(e?.stderr || e?.stdout || e)]; }
}

function computeBriefRate(): [number | null, string | null] {
  const qs = [`SELECT NULL;`, `SELECT NULL;`, `SELECT NULL;`];
  let err: string | null = null;
  for (const q of qs) {
    const [ok, out] = runPsql(q); if (!ok) { err = out; continue; }
    if (!out || out.toLowerCase() === 'null') return [null, null];
    const n = Number(out.split(/\r?\n/).at(-1)); if (!Number.isNaN(n)) return [n, null];
    err = out;
  }
  return [null, err];
}

async function main() {
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  const costByLabel = new Map<string, number>();
  const kbByLabel = new Map<string, number>();
  let subagentCost = 0; let subagentCount = 0; let totalCronCost = 0; const anomalies: string[] = [];
  try {
    for (const p of walk(SESSION_DIR)) {
      const st = statSync(p); if (st.mtimeMs < cutoff) continue;
      const first = safeReadFirstLine(p); const kb = st.size / 1024; const cost = kb * COST_PER_KB;
      if (p.toLowerCase().includes('subagent') || /agent:main:subagent/i.test(first)) { subagentCount++; subagentCost += cost; continue; }
      const label = (JSON.parse(first || '{}')?.label || p.split('/').at(-1)?.replace(/\.jsonl$/, '') || 'unknown').toString();
      costByLabel.set(label, (costByLabel.get(label) ?? 0) + cost); kbByLabel.set(label, (kbByLabel.get(label) ?? 0) + kb); totalCronCost += cost;
    }
  } catch (e: any) { anomalies.push(`session directory issue: ${String(e)}`); }
  const top = [...costByLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, cost]) => ({ name, size_kb: Math.round((kbByLabel.get(name) ?? 0) * 100) / 100, est_cost: roundMoney(cost) }));
  for (const [name, cost] of [...costByLabel.entries()].sort((a, b) => b[1] - a[1])) { if (totalCronCost > 0 && cost / totalCronCost > 0.3) anomalies.push(`cron '${name}' is ${(cost / totalCronCost * 100).toFixed(1)}% of weekly cron spend`); }
  const [briefRate, briefErr] = computeBriefRate(); if (briefErr) anomalies.push(`brief engagement query issue: ${briefErr.slice(0, 140)}`);
  writeFileSync(OUTPUT_PATH, JSON.stringify({ top_cost_crons: top, subagent_cost_7d: roundMoney(subagentCost), subagent_spawn_count: subagentCount, brief_engagement_rate: briefRate, analysis_date: new Date().toISOString(), anomalies }, null, 2));
}
main().catch((e) => { console.error(JSON.stringify({ error: String(e) })); process.exit(1); });
