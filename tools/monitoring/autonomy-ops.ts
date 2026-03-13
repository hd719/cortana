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

function summarizeList(values: string[], maxItems = 3): string {
  if (!values.length) return "none";
  const shown = values.slice(0, maxItems);
  const remainder = values.length - shown.length;
  return remainder > 0 ? `${shown.join(", ")} (+${remainder} more)` : shown.join(", ");
}

export function renderAutonomyOpsSummary(summary: ReturnType<typeof buildAutonomyOpsSummary>): string {
  const activeFollowUps = summary.scorecard.activeFollowUps
    .slice(0, 3)
    .map((item) => `${item.system}${item.taskId ? `#${item.taskId}` : ""}`);

  const lines = [
    `🧭 Autonomy - Operator ${summary.operatorState[0].toUpperCase()}${summary.operatorState.slice(1)}`,
    `Posture: ${summary.posture}`,
    `Auto-fixed: ${summarizeList(summary.autoFixed)}`,
    `Degraded: ${summarizeList(summary.degraded)}`,
    `Waiting on Hamel: ${summarizeList(summary.waitingOnHamel)}`,
    `Blocked: ${summarizeList(summary.blocked)}`,
    `Family-critical failures: ${summary.familyCritical.failures}`,
    `Counts: fixed ${summary.counts.autoRemediated}, escalated ${summary.counts.escalated}, needs-human ${summary.counts.needsHuman}`,
    `Follow-ups: ${activeFollowUps.length ? activeFollowUps.join(", ") : "none"}`,
  ];

  const rendered = lines.join("\n");
  return rendered.length <= 1200 ? rendered : `${rendered.slice(0, 1160)}\n…trimmed`;
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
