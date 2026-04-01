#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sourceRepoRoot } from "../lib/paths.js";
import { resolveIncident, upsertOpenIncident } from "./autonomy-incidents.ts";

type FailureClass =
  | "self_healable"
  | "human_auth"
  | "human_permission"
  | "control_plane"
  | "repo_runtime_drift";

type ProbeResult = {
  probe: "gog" | "apple_reminders" | "telegram_delivery" | "critical_cron_lane";
  ok: boolean;
  category?: FailureClass;
  actionable?: boolean;
  detail?: string;
};

type IncidentChange = ProbeResult & { incidentChange?: "created" | "updated" | "unchanged" };

type RuntimeJob = {
  name?: string;
  enabled?: boolean;
  state?: {
    nextRunAtMs?: number;
    lastStatus?: string;
    lastDeliveryStatus?: string;
    consecutiveErrors?: number;
  };
};

type LanesConfig = {
  familyCriticalCronNames?: string[];
};

const RUNTIME_JOBS_PATH = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");
const LANES_CONFIG_PATH = path.join(sourceRepoRoot(), "config", "autonomy-lanes.json");
const GOG_ACCOUNT = process.env.GOG_ACCOUNT ?? "hameldesai3@gmail.com";
const GOG_CALENDAR = process.env.GOG_OAUTH_CHECK_CALENDAR ?? "Clawdbot-Calendar";

function run(cmd: string, args: string[], timeoutMs = 15000) {
  const proc = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: proc.status ?? 1,
    stdout: String(proc.stdout ?? ""),
    stderr: String(proc.stderr ?? ""),
    error: proc.error,
  };
}

function compact(text: string, max = 140): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return "unknown";
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function parseJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function isAuthIssue(text: string): boolean {
  return /auth|oauth|token|invalid_grant|unauthori[sz]ed|reauth|consent|expired/i.test(text);
}

function isPermissionIssue(text: string): boolean {
  return /access denied|not determined|privacy|system settings|allow terminal|forbidden|not admin|blocked/i.test(text);
}

function isControlPlaneIssue(text: string): boolean {
  return /gateway not reachable|gateway closed|econnrefused|timed out|service unavailable|not running|failed to start cli/i.test(text);
}

function isTelegramOkStatus(text: string): boolean {
  return /(?:^|\n)[^\n]*Telegram[^\n]*(?:│|\|)\s*ON\s*(?:│|\|)\s*OK\b/im.test(text);
}

function isTelegramSpecificAuthIssue(text: string): boolean {
  return /telegram[^\n]*(unauthori[sz]ed|invalid token|token expired|revoked|forbidden|auth failed)/i.test(text);
}

function gatewayServiceHealthy(): { healthy: boolean; detail: string } {
  const r = run("openclaw", ["gateway", "status", "--no-probe"]);
  const detail = compact(`${r.stdout}\n${r.stderr}`);
  return { healthy: r.status === 0, detail };
}

function probeGog(): ProbeResult {
  const r = run("gog", ["--account", GOG_ACCOUNT, "cal", "list", GOG_CALENDAR, "--from", "today", "--plain", "--no-input"]);
  const merged = `${r.stdout}\n${r.stderr}`;

  if (r.status === 0) return { probe: "gog", ok: true };
  if (r.error?.message?.includes("ENOENT")) {
    return { probe: "gog", ok: false, category: "control_plane", actionable: true, detail: "gog CLI missing" };
  }
  if (isAuthIssue(merged)) {
    return { probe: "gog", ok: false, category: "human_auth", actionable: true, detail: compact(merged) };
  }
  return { probe: "gog", ok: false, category: "self_healable", actionable: false, detail: compact(merged) };
}

function probeAppleReminders(): ProbeResult {
  const r = run("remindctl", ["show", "upcoming", "--json", "--no-input", "--no-color"]);
  const merged = `${r.stdout}\n${r.stderr}`;

  if (r.status === 0) return { probe: "apple_reminders", ok: true };
  if (r.error?.message?.includes("ENOENT")) {
    return { probe: "apple_reminders", ok: false, category: "control_plane", actionable: true, detail: "remindctl missing" };
  }
  if (isPermissionIssue(merged)) {
    return { probe: "apple_reminders", ok: false, category: "human_permission", actionable: true, detail: compact(merged) };
  }
  if (isControlPlaneIssue(merged)) {
    return { probe: "apple_reminders", ok: false, category: "control_plane", actionable: true, detail: compact(merged) };
  }
  return { probe: "apple_reminders", ok: false, category: "self_healable", actionable: false, detail: compact(merged) };
}

function probeTelegramDelivery(): ProbeResult {
  const jsonStatus = run("openclaw", ["status", "--json"]);
  const textStatus = run("openclaw", ["status"]);
  const merged = `${jsonStatus.stdout}\n${jsonStatus.stderr}\n${textStatus.stdout}\n${textStatus.stderr}`;
  const gatewayService = gatewayServiceHealthy();

  if (jsonStatus.status !== 0 && textStatus.status !== 0) {
    return {
      probe: "telegram_delivery",
      ok: false,
      category: gatewayService.healthy ? "repo_runtime_drift" : "control_plane",
      actionable: true,
      detail: compact(merged || gatewayService.detail),
    };
  }

  if (isTelegramOkStatus(textStatus.stdout)) {
    return { probe: "telegram_delivery", ok: true };
  }

  if (isTelegramSpecificAuthIssue(merged)) {
    return { probe: "telegram_delivery", ok: false, category: "human_auth", actionable: true, detail: compact(merged) };
  }

  let gatewayReachable: boolean | null = null;
  let gatewayError = "";
  let telegramConfigured = false;
  try {
    const parsed = JSON.parse(jsonStatus.stdout || "{}") as { gateway?: { reachable?: boolean; error?: string | null }; channelSummary?: string[] };
    gatewayReachable = typeof parsed.gateway?.reachable === "boolean" ? parsed.gateway.reachable : null;
    gatewayError = String(parsed.gateway?.error ?? "");
    telegramConfigured = Array.isArray(parsed.channelSummary) && parsed.channelSummary.some((line) => /^Telegram:\s*configured/i.test(String(line)));
  } catch {
    gatewayReachable = null;
  }

  if (gatewayReachable === false && !gatewayService.healthy) {
    return {
      probe: "telegram_delivery",
      ok: false,
      category: "control_plane",
      actionable: true,
      detail: compact(gatewayError || gatewayService.detail || merged),
    };
  }

  if (!telegramConfigured) {
    return {
      probe: "telegram_delivery",
      ok: false,
      category: "repo_runtime_drift",
      actionable: true,
      detail: "telegram channel not configured in status output",
    };
  }

  if (isPermissionIssue(merged)) {
    return { probe: "telegram_delivery", ok: false, category: "human_permission", actionable: true, detail: compact(merged) };
  }

  if (telegramConfigured && gatewayService.healthy) {
    return { probe: "telegram_delivery", ok: true };
  }

  return {
    probe: "telegram_delivery",
    ok: false,
    category: "control_plane",
    actionable: true,
    detail: "telegram status unavailable in current status output",
  };
}

function probeCriticalCronLane(): ProbeResult {
  const jobsDoc = parseJsonFile<{ jobs?: RuntimeJob[] }>(RUNTIME_JOBS_PATH);
  const lanes = parseJsonFile<LanesConfig>(LANES_CONFIG_PATH);

  if (!jobsDoc || !Array.isArray(jobsDoc.jobs)) {
    return {
      probe: "critical_cron_lane",
      ok: false,
      category: "control_plane",
      actionable: true,
      detail: "runtime cron jobs unavailable",
    };
  }

  const criticalNames = new Set((lanes?.familyCriticalCronNames ?? []).map((s) => String(s)));
  if (!criticalNames.size) {
    return {
      probe: "critical_cron_lane",
      ok: false,
      category: "repo_runtime_drift",
      actionable: true,
      detail: "no critical cron names configured",
    };
  }

  const match = jobsDoc.jobs.find((job) => criticalNames.has(String(job.name ?? "")));
  if (!match) {
    return {
      probe: "critical_cron_lane",
      ok: false,
      category: "repo_runtime_drift",
      actionable: true,
      detail: "critical cron lane missing in runtime",
    };
  }

  const now = Date.now();
  const nextRunAtMs = Number(match.state?.nextRunAtMs ?? 0);
  const overdue = nextRunAtMs > 0 && now - nextRunAtMs > 60 * 60 * 1000;
  const consecutiveErrors = Number(match.state?.consecutiveErrors ?? 0);
  const lastStatus = String(match.state?.lastStatus ?? "").toLowerCase();
  const lastDeliveryStatus = String(match.state?.lastDeliveryStatus ?? "").toLowerCase();

  if (overdue) {
    return {
      probe: "critical_cron_lane",
      ok: false,
      category: "control_plane",
      actionable: true,
      detail: `critical lane overdue: ${String(match.name ?? "unknown")}`,
    };
  }

  if (consecutiveErrors >= 2 || lastStatus === "error" || lastStatus === "failed") {
    return {
      probe: "critical_cron_lane",
      ok: false,
      category: "control_plane",
      actionable: true,
      detail: `critical lane failing: ${String(match.name ?? "unknown")}`,
    };
  }

  if (lastDeliveryStatus === "error" || lastDeliveryStatus === "failed") {
    return {
      probe: "critical_cron_lane",
      ok: false,
      category: "control_plane",
      actionable: true,
      detail: `critical lane delivery degraded: ${String(match.name ?? "unknown")}`,
    };
  }

  return { probe: "critical_cron_lane", ok: true };
}

function formatActionable(results: ProbeResult[]): string {
  const byCategory = new Map<FailureClass, ProbeResult[]>();
  for (const r of results) {
    if (!r.category) continue;
    const list = byCategory.get(r.category) ?? [];
    list.push(r);
    byCategory.set(r.category, list);
  }

  const ordered: FailureClass[] = [
    "human_auth",
    "human_permission",
    "control_plane",
    "repo_runtime_drift",
    "self_healable",
  ];

  const lines: string[] = ["🛰️ Critical synthetic probes: actionable failures detected."];
  for (const category of ordered) {
    const items = byCategory.get(category);
    if (!items?.length) continue;
    const labels = items.map((i) => `${i.probe}: ${i.detail ?? "failed"}`).join("; ");
    lines.push(`- ${category}: ${compact(labels, 180)}`);
  }
  return lines.join("\n");
}

function incidentSystemForProbe(probe: ProbeResult["probe"]): string {
  if (probe === "telegram_delivery") return "channel";
  if (probe === "critical_cron_lane") return "cron";
  return probe;
}

function incidentSeverityForCategory(category: FailureClass | undefined): "warning" | "error" | "info" {
  if (category === "human_auth" || category === "human_permission" || category === "control_plane") return "error";
  if (category === "repo_runtime_drift") return "warning";
  return "info";
}

function syncIncidentState(results: ProbeResult[]): IncidentChange[] {
  return results.map((result) => {
    const incidentKey = `probe:${result.probe}`;
    if (result.ok) {
      resolveIncident(incidentKey, {
        source: "critical-synthetic-probe",
        summary: `${result.probe} healthy`,
        detail: "probe healthy",
        remediationStatus: "verified",
        autoResolved: true,
        metadata: { probe: result.probe },
      });
      return result;
    }

    const change = upsertOpenIncident({
      incidentKey,
      incidentType: result.probe,
      system: incidentSystemForProbe(result.probe),
      source: "critical-synthetic-probe",
      severity: incidentSeverityForCategory(result.category),
      summary: `${result.probe} failed`,
      detail: result.detail ?? "probe failed",
      remediationStatus: "detected",
      metadata: {
        probe: result.probe,
        category: result.category ?? "unknown",
        actionable: Boolean(result.actionable),
      },
    });
    return { ...result, incidentChange: change };
  });
}

function main(): void {
  const results = syncIncidentState([probeGog(), probeAppleReminders(), probeTelegramDelivery(), probeCriticalCronLane()]);
  const actionable = results.filter((r) => !r.ok && r.actionable);
  const stateChanged = actionable.filter((r) => r.incidentChange === "created" || r.incidentChange === "updated");

  if (actionable.length === 0 || stateChanged.length === 0) {
    console.log("NO_REPLY");
    return;
  }

  console.log(formatActionable(stateChanged));
}

main();
