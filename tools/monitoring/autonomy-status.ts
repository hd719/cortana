#!/usr/bin/env -S npx tsx
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

function runJson(script: string, args: string[] = []) {
  const proc = spawnSync("npx", ["--yes", "tsx", script, "--json", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    throw new Error((proc.stderr || proc.stdout || `${path.basename(script)} failed`).trim());
  }
  return JSON.parse((proc.stdout || "{}").trim());
}

function main() {
  const session = runJson(path.join(ROOT, "tools", "session", "session-lifecycle-policy.ts"));
  const drift = runJson(path.join(ROOT, "tools", "monitoring", "runtime-repo-drift-monitor.ts"), ["--dry-run"]);

  const autoRemediated = session.status === "remediated" ? 1 : 0;
  const escalated = session.status === "cleanup_failed" || session.status === "breach_persists" ? 1 : 0;
  const suppressed = Array.isArray(drift.suppressed) ? drift.suppressed.length : 0;
  const needsHuman = (Array.isArray(drift.actionable) ? drift.actionable.length : 0) + (Array.isArray(drift.missing) ? drift.missing.length : 0) + escalated;

  const lines = [
    "🤖 Autonomy Status",
    `- auto-remediated: ${autoRemediated}`,
    `- escalated: ${escalated}`,
    `- suppressed healthy/noise: ${suppressed}`,
    `- needs human action: ${needsHuman}`,
    `- session lifecycle: ${session.status}`,
    `- runtime drift: ${drift.status}`,
  ];

  if (Array.isArray(drift.actionable) && drift.actionable.length) {
    lines.push(`- actionable drift: ${drift.actionable.map((x: any) => x.check?.label).filter(Boolean).join(", ")}`);
  }
  if (Array.isArray(drift.suppressed) && drift.suppressed.length) {
    lines.push(`- suppressed drift: ${drift.suppressed.map((x: any) => x.check?.label).filter(Boolean).join(", ")}`);
  }

  console.log(lines.join("\n"));
}

main();
