#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { collectAutonomyStatus } from "./autonomy-status.ts";
import { buildRolloutSummary } from "./autonomy-rollout.ts";
import { runAutonomyDrill } from "./autonomy-drill.ts";

const STATE_FILE = process.env.AUTONOMY_OPS_STATE_FILE ?? path.join(os.tmpdir(), "cortana-autonomy-ops-state.json");

export function buildAutonomyOpsSummary() {
  const status = collectAutonomyStatus();
  const rollout = buildRolloutSummary();
  const drill = runAutonomyDrill();

  const operatorState = rollout.status === "attention" || drill.status === "attention"
    ? "attention"
    : rollout.status === "watch" || status.autoRemediated > 0
      ? "watch"
      : "live";

  return {
    posture: status.posture,
    operatorState,
    autoFixed: status.autoFixedItems,
    degraded: status.deferredItems,
    waitingOnHamel: status.waitingOnHuman,
    blocked: [
      ...(rollout.reasons ?? []),
      ...(drill.scenarios.filter((item) => !item.passed).map((item) => `${item.scenario}:${item.escalateWhen}`)),
    ],
    familyCritical: {
      tracked: drill.scenarios.filter((item) => item.lane === "family_critical").map((item) => item.scenario),
      failures: drill.familyCriticalFailures,
      stricterEscalation: true,
    },
    counts: {
      autoRemediated: status.autoRemediated,
      escalated: status.escalated,
      needsHuman: status.needsHuman,
      actionable: status.actionable,
      suppressed: status.suppressed,
    },
    scorecard: status.scorecard,
  };
}

function fingerprintSummary(summary: ReturnType<typeof buildAutonomyOpsSummary>): string {
  return crypto.createHash("sha1").update(JSON.stringify({
    operatorState: summary.operatorState,
    autoFixed: [...summary.autoFixed].sort(),
    degraded: [...summary.degraded].sort(),
    waitingOnHamel: [...summary.waitingOnHamel].sort(),
    blocked: [...summary.blocked].sort(),
    familyCritical: summary.familyCritical,
    counts: summary.counts,
    scorecard: summary.scorecard,
  })).digest("hex");
}

function readState(): { fingerprint?: string } {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as { fingerprint?: string };
  } catch {
    return {};
  }
}

function writeState(fingerprint: string): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ fingerprint }, null, 2));
}

export function renderAutonomyOpsSummary(summary: ReturnType<typeof buildAutonomyOpsSummary>): string {
  const lines = [
    "🧭 Cortana Operator Surface",
    `- posture: ${summary.posture}`,
    `- operator state: ${summary.operatorState}`,
    `- auto-fixed: ${summary.autoFixed.length ? summary.autoFixed.join(", ") : "none"}`,
    `- degraded: ${summary.degraded.length ? summary.degraded.join(", ") : "none"}`,
    `- waiting on Hamel: ${summary.waitingOnHamel.length ? summary.waitingOnHamel.join(", ") : "none"}`,
    `- blocked/exceeded authority: ${summary.blocked.length ? summary.blocked.join(", ") : "none"}`,
    `- family-critical tracked: ${summary.familyCritical.tracked.length ? summary.familyCritical.tracked.join(", ") : "none"}`,
    `- family-critical failures: ${summary.familyCritical.failures}`,
    `- counts: autoRemediated=${summary.counts.autoRemediated} escalated=${summary.counts.escalated} needsHuman=${summary.counts.needsHuman} actionable=${summary.counts.actionable} suppressed=${summary.counts.suppressed}`,
    `- scorecard(7d): attempts=${summary.scorecard.counts.autoFixAttempted} succeeded=${summary.scorecard.counts.autoFixSucceeded} escalations=${summary.scorecard.counts.escalations} blocked=${summary.scorecard.counts.blockedOrExceededAuthority} stale-suppressed=${summary.scorecard.counts.staleReportSuppressions} family-critical=${summary.scorecard.counts.familyCriticalFailures}`,
    `- active follow-ups: ${summary.scorecard.activeFollowUps.length ? summary.scorecard.activeFollowUps.map((item) => `${item.system}${item.taskId ? `#${item.taskId}` : ''}`).join(', ') : 'none'}`,
  ];
  return lines.join("\n");
}

function main() {
  const summary = buildAutonomyOpsSummary();
  const fingerprint = fingerprintSummary(summary);
  const prior = readState();
  const unchanged = prior.fingerprint === fingerprint;

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...summary, unchanged }, null, 2));
    return;
  }

  if (summary.operatorState === "live") {
    writeState(fingerprint);
    return;
  }

  if (unchanged) {
    return;
  }

  console.log(renderAutonomyOpsSummary(summary));
  writeState(fingerprint);
  process.exit(summary.operatorState === "attention" ? 1 : 0);
}

main();
