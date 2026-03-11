#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const STATE_FILE = process.env.AUTONOMY_REMEDIATION_STATE_FILE ?? path.join(os.tmpdir(), "cortana-autonomy-remediation-state.json");
const MAX_GATEWAY_ACTIONS_PER_WINDOW = 1;
const GATEWAY_WINDOW_MS = 30 * 60 * 1000;

type JsonMap = Record<string, unknown>;
type RemediationItem = {
  system: "gateway" | "channel" | "cron";
  status: "healthy" | "remediated" | "escalate" | "skipped";
  detail: string;
  verification?: string;
  action?: string;
};

type StateShape = {
  gatewayRestarts?: number[];
  channelRemediations?: Record<string, number>;
};

function readState(): StateShape {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as StateShape;
  } catch {
    return {};
  }
}

function writeState(state: StateShape): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function trimTimes(times: number[], now = Date.now()): number[] {
  return times.filter((ts) => now - ts <= GATEWAY_WINDOW_MS);
}

function run(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const proc = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  return {
    ok: proc.status === 0,
    stdout: String(proc.stdout ?? "").trim(),
    stderr: String(proc.stderr ?? "").trim(),
    status: proc.status,
  };
}

function runTs(relPath: string, args: string[] = []): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  return run("npx", ["--yes", "tsx", path.join(ROOT, relPath), ...args]);
}

function parseJson(text: string): JsonMap {
  try {
    return JSON.parse(text) as JsonMap;
  } catch {
    return {};
  }
}

function gatewayHealthy(): { healthy: boolean; detail: string } {
  const status = run("openclaw", ["gateway", "status"]);
  const detail = status.stderr || status.stdout || `exit=${status.status ?? "null"}`;
  return { healthy: status.ok, detail };
}

function remediateGateway(state: StateShape): RemediationItem {
  const initial = gatewayHealthy();
  if (initial.healthy) {
    return { system: "gateway", status: "healthy", detail: "gateway reachable", verification: initial.detail };
  }

  const now = Date.now();
  const recentRestarts = trimTimes(state.gatewayRestarts ?? [], now);
  if (recentRestarts.length >= MAX_GATEWAY_ACTIONS_PER_WINDOW) {
    state.gatewayRestarts = recentRestarts;
    return {
      system: "gateway",
      status: "escalate",
      detail: "gateway unhealthy and restart budget already spent",
      verification: initial.detail,
      action: "none",
    };
  }

  const restart = run("openclaw", ["gateway", "restart"]);
  recentRestarts.push(now);
  state.gatewayRestarts = recentRestarts;
  const verified = gatewayHealthy();
  if (!restart.ok || !verified.healthy) {
    return {
      system: "gateway",
      status: "escalate",
      detail: "gateway restart did not restore health",
      verification: verified.detail,
      action: "openclaw gateway restart",
    };
  }

  return {
    system: "gateway",
    status: "remediated",
    detail: "gateway restarted once and verified healthy",
    verification: verified.detail,
    action: "openclaw gateway restart",
  };
}

function remediateChannel(state: StateShape): RemediationItem {
  const check = runTs("tools/alerting/check-cron-delivery.ts");
  if (check.ok) {
    return { system: "channel", status: "healthy", detail: "delivery path healthy", verification: check.stdout || "ok" };
  }

  const issueKey = (check.stdout || check.stderr || "delivery_failed").split("\n").slice(0, 2).join("|");
  const priorAt = Number(state.channelRemediations?.[issueKey] ?? 0);
  if (priorAt && Date.now() - priorAt <= GATEWAY_WINDOW_MS) {
    return {
      system: "channel",
      status: "escalate",
      detail: "delivery degradation repeated after one remediation attempt",
      verification: check.stdout || check.stderr,
      action: "none",
    };
  }

  const gateway = gatewayHealthy();
  if (!gateway.healthy) {
    return {
      system: "channel",
      status: "skipped",
      detail: "channel remediation deferred because gateway is unhealthy",
      verification: gateway.detail,
      action: "handled_by_gateway_recovery",
    };
  }

  const restart = run("openclaw", ["gateway", "restart"]);
  state.channelRemediations = { ...(state.channelRemediations ?? {}), [issueKey]: Date.now() };
  const verifyGateway = gatewayHealthy();
  const verifyDelivery = runTs("tools/alerting/check-cron-delivery.ts");
  if (!restart.ok || !verifyGateway.healthy || !verifyDelivery.ok) {
    return {
      system: "channel",
      status: "escalate",
      detail: "delivery degradation not recovered after gateway/channel restart",
      verification: [verifyGateway.detail, verifyDelivery.stdout || verifyDelivery.stderr].filter(Boolean).join(" | "),
      action: "openclaw gateway restart",
    };
  }

  return {
    system: "channel",
    status: "remediated",
    detail: "delivery degradation recovered after one restart",
    verification: verifyDelivery.stdout || "delivery check passed",
    action: "openclaw gateway restart",
  };
}

function remediateCriticalCron(): RemediationItem {
  const authSweep = runTs("tools/alerting/openai-cron-auth-guard.ts", ["sweep"]);
  if (!authSweep.ok) {
    const parsed = parseJson(authSweep.stdout);
    const retried = Array.isArray(parsed.retried) ? parsed.retried.length : 0;
    return {
      system: "cron",
      status: retried > 0 ? "remediated" : "escalate",
      detail: retried > 0 ? "critical provider-auth cron failures retried and verified by guard" : "critical provider-auth cron failures require escalation",
      verification: authSweep.stdout || authSweep.stderr,
      action: retried > 0 ? "openai-cron-auth-guard sweep" : "none",
    };
  }

  const retry = runTs("tools/alerting/cron-auto-retry.ts", ["--critical-only", "--json"]);
  const parsed = parseJson(retry.stdout);
  const retried = Number(parsed.retried ?? 0);
  const failedAgain = Number(parsed.failedAgain ?? 0);
  const skipped = Number(parsed.skipped ?? 0);

  if (retried === 0 && skipped === 0) {
    return { system: "cron", status: "healthy", detail: "no actionable critical cron failures", verification: retry.stdout || "ok" };
  }

  if (failedAgain > 0 || skipped > 0) {
    return {
      system: "cron",
      status: "escalate",
      detail: "critical cron failures were repeated or non-transient; no looped retries",
      verification: retry.stdout || retry.stderr,
      action: retried > 0 ? "single critical cron retry" : "none",
    };
  }

  return {
    system: "cron",
    status: "remediated",
    detail: "critical transient cron failures retried once and recovered",
    verification: retry.stdout,
    action: "single critical cron retry",
  };
}

function main() {
  const state = readState();
  const items = [remediateGateway(state), remediateChannel(state), remediateCriticalCron()];
  writeState(state);

  const summary = {
    checkedAt: new Date().toISOString(),
    items,
    remediated: items.filter((item) => item.status === "remediated").length,
    escalated: items.filter((item) => item.status === "escalate").length,
    healthy: items.filter((item) => item.status === "healthy").length,
    skipped: items.filter((item) => item.status === "skipped").length,
  };

  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.escalated > 0 ? 1 : 0);
}

main();
