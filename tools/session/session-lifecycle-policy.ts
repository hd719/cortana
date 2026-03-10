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

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const POLICY_BASENAME = 'session-lifecycle-policy.json';

export function resolvePolicyPath(explicitPath = process.env.SESSION_LIFECYCLE_POLICY_PATH): string {
  const candidates = [
    explicitPath,
    path.join(REPO_ROOT, 'config', POLICY_BASENAME),
    path.join(process.cwd(), 'config', POLICY_BASENAME),
    '/Users/hd/openclaw/config/session-lifecycle-policy.json',
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

function main() {
  const policy = loadPolicy();
  const keys = getSessions();
  const counts: Record<Bucket, number> = { chat: 0, subagent: 0, cron: 0, other: 0 };

  for (const key of keys) counts[classify(key)] += 1;

  const breaches = Object.entries(policy.targets)
    .map(([bucket, target]) => ({ bucket: bucket as Bucket, count: counts[bucket as Bucket], max: target.maxEntries }))
    .filter((x) => x.count > x.max);

  const report = {
    totalSessions: keys.length,
    counts,
    targets: policy.targets,
    breaches,
  };

  if (breaches.length === 0) {
    console.log('NO_REPLY');
    return;
  }

  const lines = [
    '⚠️ Session Lifecycle Policy Drift',
    `Total sessions: ${report.totalSessions}`,
    `Counts: chat=${counts.chat}, subagent=${counts.subagent}, cron=${counts.cron}, other=${counts.other}`,
    ...breaches.map((b) => `- ${b.bucket}: ${b.count} > ${b.max}`),
    'Run `openclaw sessions cleanup --all-agents --enforce` and/or tighten session.maintenance caps.',
  ];
  console.log(lines.join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
