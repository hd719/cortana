#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { buildAutonomyOpsSummary } from "./autonomy-ops.ts";
import { collectAutonomyStatus } from "./autonomy-status.ts";

type DigestState = {
  fingerprint?: string;
  lastSentAt?: string;
};

const STATE_FILE = process.env.AUTONOMY_DAILY_DIGEST_STATE_FILE
  ?? path.join(os.tmpdir(), "cortana-autonomy-daily-digest-state.json");

function readState(): DigestState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as DigestState;
  } catch {
    return {};
  }
}

function writeState(state: DigestState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function stableFingerprint(summary: ReturnType<typeof buildAutonomyOpsSummary>, status: ReturnType<typeof collectAutonomyStatus>): string {
  const payload = {
    operatorState: summary.operatorState,
    autoFixed: [...summary.autoFixed].sort(),
    degraded: [...summary.degraded].sort(),
    waitingOnHamel: [...summary.waitingOnHamel].sort(),
    blocked: [...summary.blocked].sort(),
    familyCritical: summary.familyCritical,
    failedRecoveredItems: [...status.failedRecoveredItems].sort(),
  };
  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

export function buildDailyDigest(now = new Date()) {
  const summary = buildAutonomyOpsSummary();
  const status = collectAutonomyStatus();
  const fingerprint = stableFingerprint(summary, status);
  const prior = readState();
  const unchanged = prior.fingerprint === fingerprint;

  const lines = [
    `📘 Autonomy - Daily Executive Digest (${now.toISOString().slice(0, 10)})`,
    `State: ${summary.operatorState}`,
    `Auto-fixed: ${summary.autoFixed.length ? summary.autoFixed.join(", ") : "none"}`,
    `Recovered after degradation: ${status.failedRecoveredItems.length ? status.failedRecoveredItems.join(", ") : "none"}`,
    `Needs Hamel: ${summary.waitingOnHamel.length ? summary.waitingOnHamel.join(", ") : "none"}`,
    `Blocked / exceeded authority: ${summary.blocked.length ? summary.blocked.join(", ") : "none"}`,
    `Family-critical: tracked ${summary.familyCritical.tracked.length || 0}, failures ${summary.familyCritical.failures}`,
    `Scorecard(7d): attempts ${status.scorecard.counts.autoFixAttempted}, succeeded ${status.scorecard.counts.autoFixSucceeded}, escalations ${status.scorecard.counts.escalations}, blocked ${status.scorecard.counts.blockedOrExceededAuthority}, stale-suppressed ${status.scorecard.counts.staleReportSuppressions}`,
    `Active follow-ups: ${status.scorecard.activeFollowUps.length ? status.scorecard.activeFollowUps.map((item) => `${item.system}${item.taskId ? `#${item.taskId}` : ''}`).join(', ') : 'none'}`,
    `Noise suppressed: ${summary.counts.suppressed}`,
  ];

  return {
    ok: true,
    sentAt: now.toISOString(),
    fingerprint,
    unchanged,
    summary,
    digest: lines.join("\n"),
  };
}

function main() {
  const payload = buildDailyDigest(new Date());
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(payload.digest);
  writeState({ fingerprint: payload.fingerprint, lastSentAt: payload.sentAt });
}

main();
