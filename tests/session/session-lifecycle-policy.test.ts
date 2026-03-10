import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const repoPolicy = path.resolve(__dirname, '../../config/session-lifecycle-policy.json');

describe('session lifecycle policy path resolution', () => {
  beforeEach(() => {
    delete process.env.SESSION_LIFECYCLE_POLICY_PATH;
  });

  it('prefers explicit env override when provided', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-policy-'));
    const customPath = path.join(tempDir, 'custom-policy.json');
    fs.writeFileSync(customPath, '{"version":1,"targets":{"chat":{"maxEntries":1,"pruneAfter":"1d"},"subagent":{"maxEntries":1,"pruneAfter":"1d"},"cron":{"maxEntries":1,"pruneAfter":"1d"},"other":{"maxEntries":1,"pruneAfter":"1d"}}}');
    process.env.SESSION_LIFECYCLE_POLICY_PATH = customPath;

    const mod = await import('../../tools/session/session-lifecycle-policy.ts');
    expect(mod.resolvePolicyPath()).toBe(customPath);
  });

  it('resolves repo config even when cwd is arbitrary', async () => {
    const prev = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-policy-cwd-'));
    process.chdir(tempDir);
    try {
      const mod = await import('../../tools/session/session-lifecycle-policy.ts');
      expect(mod.resolvePolicyPath()).toBe(repoPolicy);
    } finally {
      process.chdir(prev);
    }
  });

  it('shows all attempted paths when config cannot be found', async () => {
    const mod = await import('../../tools/session/session-lifecycle-policy.ts');
    const missing = path.join(os.tmpdir(), `missing-${Date.now()}.json`);
    const prev = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-policy-missing-'));
    process.chdir(tempDir);
    const originalExists = fs.existsSync;
    fs.existsSync = ((candidate: fs.PathLike) => {
      const value = String(candidate);
      if (value === missing) return false;
      if (value === repoPolicy) return false;
      if (value === '/Users/hd/openclaw/config/session-lifecycle-policy.json') return false;
      if (value.endsWith('/config/session-lifecycle-policy.json')) return false;
      return originalExists(candidate);
    }) as typeof fs.existsSync;

    try {
      expect(() => mod.resolvePolicyPath(missing)).toThrow(/Tried:/);
      expect(() => mod.resolvePolicyPath(missing)).toThrow(/missing-/);
    } finally {
      fs.existsSync = originalExists;
      process.chdir(prev);
    }
  });
});
