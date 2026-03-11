#!/usr/bin/env -S npx tsx
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAutonomyConfig } from "./autonomy-lanes.ts";

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
  const config = loadAutonomyConfig();
  const session = runJson(path.join(ROOT, "tools", "session", "session-lifecycle-policy.ts"));
  const drift = runJson(path.join(ROOT, "tools", "monitoring", "runtime-repo-drift-monitor.ts"), ["--dry-run"]);
  const remediation = runJson(path.join(ROOT, "tools", "monitoring", "autonomy-remediation.ts"));

  const remediationItems = Array.isArray(remediation.items) ? remediation.items : [];
  const autoFixedItems = remediationItems.filter((item: any) => item?.status === "remediated").map((item: any) => item.system);
  const failedRecoveredItems = remediationItems
    .filter((item: any) => item?.status === "remediated" && ["gateway", "channel", "cron"].includes(String(item.system)))
    .map((item: any) => item.system);
  const deferredItems = remediationItems
    .filter((item: any) => item?.status === "skipped" || item?.status === "escalate")
    .map((item: any) => `${item.system}:${item.status}`);

  const autoRemediated = (session.status === "remediated" ? 1 : 0) + Number(remediation.remediated ?? 0);
  const escalated = (session.status === "cleanup_failed" || session.status === "breach_persists" ? 1 : 0) + Number(remediation.escalated ?? 0);
  const suppressed = Array.isArray(drift.suppressed) ? drift.suppressed.length : 0;
  const actionable = Array.isArray(drift.actionable) ? drift.actionable.length : 0;
  const missing = Array.isArray(drift.missing) ? drift.missing.length : 0;
  const needsHuman = actionable + missing + escalated;

  const lines = [
    "🤖 Autonomy Status",
    `- posture: ${config.posture}`,
    `- auto-remediated: ${autoRemediated}`,
    `- escalated: ${escalated}`,
    `- suppressed healthy/noise: ${suppressed}`,
    `- needs human action: ${needsHuman}`,
    `- auto-fixed today: ${autoFixedItems.length ? autoFixedItems.join(", ") : "none"}`,
    `- failed then recovered: ${failedRecoveredItems.length ? failedRecoveredItems.join(", ") : "none"}`,
    `- waiting on Hamel: ${actionable || missing || escalated ? [
      actionable ? `${actionable} drift item(s)` : "",
      missing ? `${missing} missing input(s)` : "",
      escalated ? `${escalated} escalated check(s)` : "",
    ].filter(Boolean).join(", ") : "none"}`,
    `- deferred/exceeded authority: ${deferredItems.length ? deferredItems.join(", ") : "none"}`,
    `- session lifecycle: ${session.status}`,
    `- runtime drift: ${drift.status}`,
    `- service remediation: remediated=${Number(remediation.remediated ?? 0)} escalated=${Number(remediation.escalated ?? 0)} healthy=${Number(remediation.healthy ?? 0)} skipped=${Number(remediation.skipped ?? 0)}`,
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
