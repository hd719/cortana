#!/usr/bin/env npx tsx
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = __dirname;
let pass = 0, fail = 0, skip = 0;
const runCase = (name: string, cmd: string) => {
  console.log(`\n==> ${name}`);
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: 'pipe', shell: '/bin/bash' });
    console.log(out);
    if (out.includes('SKIPPED')) skip++; else pass++;
  } catch (e: any) {
    const out = String(e?.stdout ?? '') + String(e?.stderr ?? '');
    console.log(out);
    if (out.includes('SKIPPED')) skip++; else fail++;
  }
};

runCase('test_vector_health_gate.ts', `npx tsx ${resolve(ROOT, 'test_vector_health_gate.ts')}`);
runCase('test_safe_memory_search.ts', `npx tsx ${resolve(ROOT, 'test_safe_memory_search.ts')}`);
for (const t of ['test_compact_memory.ts','test_rotate_artifacts.ts','test_meta_monitor.ts','test_quarantine_tracker.ts','test_idempotency.ts','test_heartbeat_validation.ts','test_pipeline_reconciliation.ts','test_alert_intent.ts','test_emit_run_event.ts']) runCase(t, `npx tsx ${resolve(ROOT, t)}`);
console.log(`\nSUMMARY: pass=${pass} fail=${fail} skipped=${skip}`);
process.exit(fail === 0 ? 0 : 1);
