#!/usr/bin/env -S npx tsx
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAutonomyConfig } from "./autonomy-lanes.ts";
import { collectAutonomyScorecard } from "./autonomy-scorecard.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

type JsonMap = Record<string, any>;

type AutonomyStatusSummary = {
  posture: string;
  autoRemediated: number;
  escalated: number;
  suppressed: number;
  actionable: number;
  missing: number;
  needsHuman: number;
  autoFixedItems: string[];
  failedRecoveredItems: string[];
  deferredItems: string[];
  waitingOnHuman: string[];
  sessionStatus: string;
  driftStatus: string;
  remediationCounts: {
    remediated: number;
    escalated: number;
    healthy: number;
    skipped: number;
  };
  familyCritical: {
    recovered: number;
    escalated: number;
  };
  actionableDriftLabels: string[];
  suppressedDriftLabels: string[];
  scorecard: ReturnType<typeof collectAutonomyScorecard>;
};

function runJson(script: string, args: string[] = []): JsonMap {
  const proc = spawnSync("npx", ["--yes", "tsx", script, "--json", ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });

  const stdout = String(proc.stdout ?? "").trim();
  if (stdout) {
    try {
      return JSON.parse(stdout) as JsonMap;
    } catch {
      // Fall through to the status/error handling below.
    }
  }

  if (proc.status !== 0) {
    throw new Error((proc.stderr || stdout || `${path.basename(script)} failed`).trim());
  }
  return {};
}

export function collectAutonomyStatus(): AutonomyStatusSummary {
  const config = loadAutonomyConfig();
  const session = runJson(path.join(ROOT, "tools", "session", "session-lifecycle-policy.ts"));
  const drift = runJson(path.join(ROOT, "tools", "monitoring", "runtime-repo-drift-monitor.ts"), ["--dry-run"]);
  const remediation = runJson(path.join(ROOT, "tools", "monitoring", "autonomy-remediation.ts"));
  const scorecard = collectAutonomyScorecard();

  const remediationItems = Array.isArray(remediation.items) ? remediation.items : [];
  const autoFixedItems = remediationItems.filter((item: any) => item?.status === "remediated").map((item: any) => String(item.system));
  const cronVerification = remediationItems.find((item: any) => item?.system === "cron")?.verification;
  const cronSummary = typeof cronVerification === "string" ? (() => {
    try {
      return JSON.parse(cronVerification) as JsonMap;
    } catch {
      return {} as JsonMap;
    }
  })() : {};
  const failedRecoveredItems = remediationItems
    .filter((item: any) => item?.status === "remediated" && ["gateway", "channel", "cron"].includes(String(item.system)))
    .map((item: any) => String(item.system));
  const deferredItems = remediationItems
    .filter((item: any) => item?.status === "skipped" || item?.status === "escalate")
    .map((item: any) => `${item.system}:${item.status}`);

  const remediationEscalated = Number(remediation.escalated ?? 0);
  const autoRemediated = (session.status === "remediated" ? 1 : 0) + Number(remediation.remediated ?? 0);
  const escalated = (session.status === "cleanup_failed" || session.status === "breach_persists" ? 1 : 0) + remediationEscalated;
  const suppressed = Array.isArray(drift.suppressed) ? drift.suppressed.length : 0;
  const actionable = Array.isArray(drift.actionable) ? drift.actionable.length : 0;
  const missing = Array.isArray(drift.missing) ? drift.missing.length : 0;
  const needsHuman = actionable + missing + escalated;
  const waitingOnHuman = [
    actionable ? `${actionable} drift item(s)` : "",
    missing ? `${missing} missing input(s)` : "",
    escalated ? `${escalated} escalated check(s)` : "",
  ].filter(Boolean);

  return {
    posture: String(config.posture),
    autoRemediated,
    escalated,
    suppressed,
    actionable,
    missing,
    needsHuman,
    autoFixedItems,
    failedRecoveredItems,
    deferredItems,
    waitingOnHuman,
    sessionStatus: String(session.status ?? "unknown"),
    driftStatus: String(drift.status ?? "unknown"),
    remediationCounts: {
      remediated: Number(remediation.remediated ?? 0),
      escalated: remediationEscalated,
      healthy: Number(remediation.healthy ?? 0),
      skipped: Number(remediation.skipped ?? 0),
    },
    familyCritical: {
      recovered: Number((cronSummary.familyCritical as JsonMap | undefined)?.recovered ?? 0),
      escalated: Number((cronSummary.familyCritical as JsonMap | undefined)?.escalations ?? 0),
    },
    actionableDriftLabels: Array.isArray(drift.actionable) ? drift.actionable.map((x: any) => x.check?.label).filter(Boolean) : [],
    suppressedDriftLabels: Array.isArray(drift.suppressed) ? drift.suppressed.map((x: any) => x.check?.label).filter(Boolean) : [],
    scorecard,
  };
}

export function renderAutonomyStatus(summary: AutonomyStatusSummary): string {
  const lines = [
    "🤖 Autonomy Status",
    `- posture: ${summary.posture}`,
    `- auto-remediated: ${summary.autoRemediated}`,
    `- escalated: ${summary.escalated}`,
    `- suppressed healthy/noise: ${summary.suppressed}`,
    `- needs human action: ${summary.needsHuman}`,
    `- auto-fixed today: ${summary.autoFixedItems.length ? summary.autoFixedItems.join(", ") : "none"}`,
    `- failed then recovered: ${summary.failedRecoveredItems.length ? summary.failedRecoveredItems.join(", ") : "none"}`,
    `- waiting on Hamel: ${summary.waitingOnHuman.length ? summary.waitingOnHuman.join(", ") : "none"}`,
    `- deferred/exceeded authority: ${summary.deferredItems.length ? summary.deferredItems.join(", ") : "none"}`,
    `- family-critical lane: recovered=${summary.familyCritical.recovered} escalated=${summary.familyCritical.escalated}`,
    `- session lifecycle: ${summary.sessionStatus}`,
    `- runtime drift: ${summary.driftStatus}`,
    `- service remediation: remediated=${summary.remediationCounts.remediated} escalated=${summary.remediationCounts.escalated} healthy=${summary.remediationCounts.healthy} skipped=${summary.remediationCounts.skipped}`,
    `- scorecard(7d): attempts=${summary.scorecard.counts.autoFixAttempted} succeeded=${summary.scorecard.counts.autoFixSucceeded} escalations=${summary.scorecard.counts.escalations} blocked=${summary.scorecard.counts.blockedOrExceededAuthority} stale-suppressed=${summary.scorecard.counts.staleReportSuppressions} family-critical=${summary.scorecard.counts.familyCriticalFailures}`,
    `- active follow-ups: ${summary.scorecard.activeFollowUps.length ? summary.scorecard.activeFollowUps.map((item) => `${item.system}${item.taskId ? `#${item.taskId}` : ''}`).join(', ') : 'none'}`,
  ];

  if (summary.actionableDriftLabels.length) {
    lines.push(`- actionable drift: ${summary.actionableDriftLabels.join(", ")}`);
  }
  if (summary.suppressedDriftLabels.length) {
    lines.push(`- suppressed drift: ${summary.suppressedDriftLabels.join(", ")}`);
  }

  return lines.join("\n");
}

function main() {
  const summary = collectAutonomyStatus();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(renderAutonomyStatus(summary));
}

main();
