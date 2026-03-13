#!/usr/bin/env npx tsx
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

type Bucket = 'chat' | 'subagent' | 'cron' | 'other';

type Target = { maxEntries: number; pruneAfter: string };

type Policy = {
  version: number;
  targets: Record<Bucket, Target>;
};

type SessionItem = {
  key?: string;
  sessionKey?: string;
};

type CleanupResult = {
  ok: boolean;
  changedCount: number;
  raw: string;
  error?: string;
};

type Mode = 'text' | 'json';

type Report = {
  status: 'healthy' | 'remediated' | 'cleanup_failed' | 'breach_persists';
  beforeCounts: Record<Bucket, number>;
  afterCounts: Record<Bucket, number>;
  breachesBefore: Array<{ bucket: Bucket; count: number; max: number }>;
  breachesAfter: Array<{ bucket: Bucket; count: number; max: number }>;
  cleanupChangedCount: number;
  cleanupOk: boolean;
  cleanupError?: string;
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const POLICY_BASENAME = 'session-lifecycle-policy.json';

export function resolvePolicyPath(explicitPath = process.env.SESSION_LIFECYCLE_POLICY_PATH): string {
  const candidates = [
    explicitPath,
    path.join(REPO_ROOT, 'config', POLICY_BASENAME),
    path.join(process.cwd(), 'config', POLICY_BASENAME),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `session lifecycle policy config not found. Tried: ${candidates.join(', ') || '(no candidate paths)'}`
  );
}

function loadPolicy(): Policy {
  const policyPath = resolvePolicyPath();
  return JSON.parse(fs.readFileSync(policyPath, 'utf8')) as Policy;
}

function classify(key: string): Bucket {
  if (key.includes(':subagent:')) return 'subagent';
  if (key.includes(':cron:')) return 'cron';
  if (key.includes(':telegram:') || key.includes(':webchat:') || key.includes(':discord:') || key.includes(':signal:') || key.includes(':imessage:')) return 'chat';
  return 'other';
}

function getSessions(): string[] {
  const proc = spawnSync('openclaw', ['sessions', '--all-agents', '--json'], { encoding: 'utf8' });
  if (proc.status !== 0) {
    throw new Error(proc.stderr || proc.stdout || 'openclaw sessions failed');
  }
  const raw = JSON.parse(proc.stdout || '{}');
  const sessions: SessionItem[] = Array.isArray(raw)
    ? raw
    : Array.isArray(raw.sessions)
      ? raw.sessions
      : [];
  return sessions
    .map((s) => s.sessionKey || s.key)
    .filter((v): v is string => typeof v === 'string');
}

function countBuckets(keys: string[]): Record<Bucket, number> {
  const counts: Record<Bucket, number> = { chat: 0, subagent: 0, cron: 0, other: 0 };
  for (const key of keys) counts[classify(key)] += 1;
  return counts;
}

function getBreaches(policy: Policy, counts: Record<Bucket, number>) {
  return Object.entries(policy.targets)
    .map(([bucket, target]) => ({ bucket: bucket as Bucket, count: counts[bucket as Bucket], max: target.maxEntries }))
    .filter((x) => x.count > x.max);
}

function runCleanup(): CleanupResult {
  const proc = spawnSync('openclaw', ['sessions', 'cleanup', '--all-agents', '--enforce', '--json'], { encoding: 'utf8' });
  const raw = `${proc.stdout ?? ''}${proc.stderr ?? ''}`.trim();
  if (proc.status !== 0) {
    return { ok: false, changedCount: 0, raw, error: raw || 'openclaw sessions cleanup failed' };
  }

  let changedCount = 0;
  try {
    const parsed = JSON.parse(proc.stdout || '{}');
    const candidates = [
      parsed?.changedCount,
      parsed?.cleanedCount,
      parsed?.removedCount,
      parsed?.summary?.changedCount,
      parsed?.summary?.cleanedCount,
      parsed?.summary?.removedCount,
      Array.isArray(parsed?.changed) ? parsed.changed.length : undefined,
      Array.isArray(parsed?.cleaned) ? parsed.cleaned.length : undefined,
      Array.isArray(parsed?.removed) ? parsed.removed.length : undefined,
    ].filter((v) => typeof v === 'number' && Number.isFinite(v)) as number[];
    changedCount = candidates.length ? Math.max(...candidates) : 0;
  } catch {
    changedCount = 0;
  }

  return { ok: true, changedCount, raw };
}

function formatCounts(counts: Record<Bucket, number>) {
  return `chat=${counts.chat}, subagent=${counts.subagent}, cron=${counts.cron}, other=${counts.other}`;
}

function evaluate(): Report {
  const policy = loadPolicy();
  const beforeKeys = getSessions();
  const beforeCounts = countBuckets(beforeKeys);
  const breachesBefore = getBreaches(policy, beforeCounts);

  if (breachesBefore.length === 0) {
    return {
      status: 'healthy',
      beforeCounts,
      afterCounts: beforeCounts,
      breachesBefore,
      breachesAfter: breachesBefore,
      cleanupChangedCount: 0,
      cleanupOk: true,
    };
  }

  const cleanup = runCleanup();
  if (!cleanup.ok) {
    return {
      status: 'cleanup_failed',
      beforeCounts,
      afterCounts: beforeCounts,
      breachesBefore,
      breachesAfter: breachesBefore,
      cleanupChangedCount: 0,
      cleanupOk: false,
      cleanupError: cleanup.error,
    };
  }

  const afterKeys = getSessions();
  const afterCounts = countBuckets(afterKeys);
  const breachesAfter = getBreaches(policy, afterCounts);

  if (breachesAfter.length === 0) {
    return {
      status: 'remediated',
      beforeCounts,
      afterCounts,
      breachesBefore,
      breachesAfter,
      cleanupChangedCount: cleanup.changedCount,
      cleanupOk: true,
    };
  }

  return {
    status: 'breach_persists',
    beforeCounts,
    afterCounts,
    breachesBefore,
    breachesAfter,
    cleanupChangedCount: cleanup.changedCount,
    cleanupOk: true,
  };
}

function parseMode(argv: string[]): Mode {
  return argv.includes('--json') ? 'json' : 'text';
}

export function main() {
  const mode = parseMode(process.argv.slice(2));
  const report = evaluate();

  if (mode === 'json') {
    console.log(JSON.stringify(report));
    return;
  }

  if (report.status === 'healthy' || report.status === 'remediated') {
    console.log('NO_REPLY');
    return;
  }

  if (report.status === 'cleanup_failed') {
    const lines = [
      '⚠️ Session lifecycle cleanup failed',
      `Counts: ${formatCounts(report.beforeCounts)}`,
      ...report.breachesBefore.map((b) => `- ${b.bucket}: ${b.count} > ${b.max}`),
      `Root cause: cleanup command failed (${report.cleanupError})`,
      'Next: inspect session churn and rerun cleanup manually.',
    ];
    console.log(lines.join('\n'));
    return;
  }

  const lines = [
    '⚠️ Session lifecycle breach persists after cleanup',
    `Before: ${formatCounts(report.beforeCounts)}`,
    `After: ${formatCounts(report.afterCounts)}`,
    `Cleanup changed: ${report.cleanupChangedCount}`,
    ...report.breachesAfter.map((b) => `- ${b.bucket}: ${b.count} > ${b.max}`),
    'Next: inspect churn source and tighten session lifecycle caps or offending workflows.',
  ];
  console.log(lines.join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
