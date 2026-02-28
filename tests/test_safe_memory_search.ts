#!/usr/bin/env npx tsx
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function main() {
  const mod: any = await import('../tools/memory/safe-memory-search.ts');
  const tmp = mkdtempSync(join(tmpdir(), 'safe-memory-search-'));
  mkdirSync(join(tmp, 'memory'), { recursive: true });
  writeFileSync(join(tmp, 'MEMORY.md'), 'Alpha beta gamma\nvector outage handling\n');
  mod.WORKSPACE = tmp;
  mod.STATE_PATH = join(tmp, 'memory/vector-memory-health-state.json');

  mod.vector_search = async () => [null, 'embedding error 429 failed quota'];
  process.argv = ['safe-memory-search.ts', 'vector outage', '--json'];
  assert.equal(await mod.main(), 0);

  mod.vector_search = async () => [[{ snippet: 'hit' }], ''];
  process.argv = ['safe-memory-search.ts', 'anything', '--json'];
  assert.equal(await mod.main(), 0);
  console.log('PASS: safe-memory-search');
}
main().catch((e) => { console.error(e); process.exit(1); });
