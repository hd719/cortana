#!/usr/bin/env -S npx tsx
import { collectAutonomyStatus } from "./autonomy-status.ts";

type RolloutStatus = "live" | "watch" | "attention";

type RolloutSummary = {
  status: RolloutStatus;
  activation: "active" | "hold";
  cadence: string;
  operatorLoop: string;
  posture: string;
  autoRemediated: number;
  escalated: number;
  needsHuman: number;
  reasons: string[];
};

export function buildRolloutSummary() : RolloutSummary {
  const status = collectAutonomyStatus();
  const reasons: string[] = [];

  if (status.escalated > 0) {
    reasons.push(`${status.escalated} escalated check(s)`);
  }
  if (status.actionable > 0) {
    reasons.push(`${status.actionable} actionable drift item(s)`);
  }
  if (status.missing > 0) {
    reasons.push(`${status.missing} missing input(s)`);
  }
  if (status.deferredItems.length > 0) {
    reasons.push(`deferred: ${status.deferredItems.join(", ")}`);
  }

  const rolloutStatus: RolloutStatus = status.escalated > 0 || status.needsHuman > 0
    ? "attention"
    : status.autoRemediated > 0
      ? "watch"
      : "live";

  return {
    status: rolloutStatus,
    activation: rolloutStatus === "attention" ? "hold" : "active",
    cadence: "check every 4h; operator summary only on attention",
    operatorLoop: rolloutStatus === "attention"
      ? "failures explicit; operator review required before declaring green"
      : rolloutStatus === "watch"
        ? "healthy path quiet; continue observing bounded auto-remediation"
        : "healthy path quiet; continue steady-state monitoring",
    posture: status.posture,
    autoRemediated: status.autoRemediated,
    escalated: status.escalated,
    needsHuman: status.needsHuman,
    reasons,
  };
}

export function renderRolloutSummary(summary: RolloutSummary): string {
  const lines = [
    "🟢 Autonomy rollout live" ,
    `- posture: ${summary.posture}`,
    `- status: ${summary.status}`,
    `- activation: ${summary.activation}`,
    `- cadence: ${summary.cadence}`,
    `- operator loop: ${summary.operatorLoop}`,
  ];

  if (summary.autoRemediated > 0) {
    lines.push(`- bounded fixes observed: ${summary.autoRemediated}`);
  }
  if (summary.reasons.length > 0) {
    lines.push(`- attention reasons: ${summary.reasons.join(", ")}`);
  }

  return lines.join("\n");
}

export function runAutonomyRolloutCli(argv = process.argv.slice(2)): void {
  const summary = buildRolloutSummary();
  if (argv.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  if (summary.status === "live") {
    return;
  }

  console.log(renderRolloutSummary(summary));
  process.exit(summary.status === "attention" ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAutonomyRolloutCli();
}
