#!/usr/bin/env npx tsx
import assert from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main() {
  const mod: any = await import('../tools/memory/vector-health-gate.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'vector-health-gate-'));
  mod.STATE_PATH = join(tmp, 'vector-state.json');

  mod.run = (cmd: string[]) => {
    if (cmd[0] === 'openclaw' && cmd[1] === 'memory' && cmd[2] === 'status') return { returncode: 0, stdout: JSON.stringify([{ status: { files: 2, chunks: 0, provider: 'x', model: 'y' } }]), stderr: '' };
    if (cmd[0] === 'openclaw' && cmd[1] === 'memory' && cmd[2] === 'search') return { returncode: 0, stdout: '[]', stderr: '' };
    if (cmd[0] === 'openclaw' && cmd[1] === 'memory' && cmd[2] === 'index') return { returncode: 0, stdout: 'ok', stderr: '' };
    return { returncode: 0, stdout: '0\n', stderr: '' };
  };
  process.argv = ['vector-health-gate.ts', '--json'];
  assert.equal(await mod.main(), 0);

  const st = JSON.parse(readFileSync(mod.STATE_PATH, 'utf8'));
  assert.ok(st);
  console.log('PASS: vector-health-gate');
}
main().catch((e) => { console.error(e); process.exit(1); });
