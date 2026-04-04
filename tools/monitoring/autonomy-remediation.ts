#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadAutonomyConfig } from "./autonomy-lanes.ts";
import { resolveIncident, upsertOpenIncident } from "./autonomy-incidents.ts";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const STATE_FILE = process.env.AUTONOMY_REMEDIATION_STATE_FILE ?? path.join(os.tmpdir(), "cortana-autonomy-remediation-state.json");
const MAX_GATEWAY_ACTIONS_PER_WINDOW = 1;
const GATEWAY_WINDOW_MS = 30 * 60 * 1000;
const DB = process.env.CORTANA_DB ?? "cortana";
const PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql";

type JsonMap = Record<string, unknown>;
type RemediationItem = {
  system: "gateway" | "channel" | "cron" | "session" | "browser" | "vacation" | "runtime";
  status: "healthy" | "remediated" | "escalate" | "skipped";
  detail: string;
  verification?: string;
  action?: string;
  familyCritical?: boolean;
  laneLabel?: string;
  verificationStatus?: "verified" | "uncertain";
  escalationPath?: string;
  policyLesson?: string;
  followUpTaskId?: number | null;
  freshnessSuppressed?: boolean;
};

type StateShape = {
  gatewayRestarts?: number[];
  browserRestarts?: number[];
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

function sqlEscape(value: string): string {
  return value.replaceAll("'", "''");
}

function psql(sql: string): string {
  const proc = spawnSync(PSQL, [DB, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (proc.status !== 0) {
    throw new Error((proc.stderr || proc.stdout || "psql failed").trim());
  }
  return String(proc.stdout ?? "").trim();
}

function gatewayHealthy(): { healthy: boolean; detail: string } {
  const status = run("openclaw", ["gateway", "status", "--no-probe"]);
  const detail = status.stderr || status.stdout || `exit=${status.status ?? "null"}`;
  return { healthy: status.ok, detail };
}

function browserCdpHealthy(): { healthy: boolean; detail: string } {
  const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = fs.readFileSync(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as {
      browser?: { enabled?: boolean; defaultProfile?: string; profiles?: Record<string, { cdpUrl?: string; cdpPort?: number }> };
    };
    if (parsed.browser?.enabled === false) {
      return { healthy: true, detail: "browser disabled" };
    }
    const profileName = parsed.browser?.defaultProfile ?? "chrome-relay";
    const profile = parsed.browser?.profiles?.[profileName];
    const cdpUrl =
      typeof profile?.cdpUrl === "string" && profile.cdpUrl.trim().length > 0
        ? profile.cdpUrl.trim()
        : Number.isFinite(profile?.cdpPort)
          ? `http://127.0.0.1:${Number(profile?.cdpPort)}`
          : "";
    if (!cdpUrl) {
      return { healthy: false, detail: "cdp profile/url missing" };
    }
    const target = cdpUrl.endsWith("/") ? `${cdpUrl}json/version` : `${cdpUrl}/json/version`;
    const probe = run("curl", ["-sSf", "--max-time", "6", target]);
    return {
      healthy: probe.ok,
      detail: probe.ok ? target : (probe.stderr || probe.stdout || target),
    };
  } catch {
    return { healthy: false, detail: "runtime browser config unavailable" };
  }
}

function browserRelayLaunchTarget(): { profileName: string; cdpUrl: string } | null {
  const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  try {
    const raw = fs.readFileSync(cfgPath, "utf8");
    const parsed = JSON.parse(raw) as {
      browser?: { enabled?: boolean; defaultProfile?: string; profiles?: Record<string, { cdpUrl?: string; cdpPort?: number }> };
    };
    if (parsed.browser?.enabled === false) return null;
    const profileName = parsed.browser?.defaultProfile ?? "chrome-relay";
    const profile = parsed.browser?.profiles?.[profileName];
    const cdpUrl =
      typeof profile?.cdpUrl === "string" && profile.cdpUrl.trim().length > 0
        ? profile.cdpUrl.trim()
        : Number.isFinite(profile?.cdpPort)
          ? `http://127.0.0.1:${Number(profile?.cdpPort)}`
          : "";
    return cdpUrl ? { profileName, cdpUrl } : null;
  } catch {
    return null;
  }
}

function localCdpPort(cdpUrl: string): number | null {
  try {
    const parsed = new URL(cdpUrl);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) return null;
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

function launchBrowserRelay(profileName: string, cdpUrl: string): { ok: boolean; detail: string } {
  const port = localCdpPort(cdpUrl);
  if (!port) return { ok: false, detail: `unsupported cdp url for local relay launch: ${cdpUrl}` };
  const appCandidates = [
    "/Applications/Google Chrome.app",
    "/Applications/Chromium.app",
    "/Applications/Brave Browser.app",
    "/Applications/Microsoft Edge.app",
  ];
  const app = appCandidates.find((candidate) => fs.existsSync(candidate));
  if (!app) return { ok: false, detail: "no supported Chrome-family app found" };
  const userDataDir = path.join(os.homedir(), ".openclaw", "browser", profileName);
  fs.mkdirSync(userDataDir, { recursive: true });
  const launch = run("open", ["-na", app, "--args", `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`]);
  return { ok: launch.ok, detail: launch.stderr || launch.stdout || `${app} on ${port}` };
}

function verifyBrowserCdp(attempts = 8): { healthy: boolean; detail: string } {
  let current = browserCdpHealthy();
  if (current.healthy) return current;
  for (let i = 1; i < attempts; i += 1) {
    run("sleep", ["1"]);
    current = browserCdpHealthy();
    if (current.healthy) return current;
  }
  return current;
}

function remediateBrowser(state: StateShape): RemediationItem {
  const initial = browserCdpHealthy();
  if (initial.detail === "runtime browser config unavailable" || initial.detail === "cdp profile/url missing") {
    return {
      system: "browser",
      status: "skipped",
      detail: "browser watchdog skipped (runtime cdp config unavailable)",
      verification: initial.detail,
      verificationStatus: "uncertain",
      policyLesson: "browser watchdog requires runtime cdp profile configuration",
    };
  }
  if (initial.healthy) {
    return {
      system: "browser",
      status: "healthy",
      detail: "browser cdp healthy",
      verification: initial.detail,
      verificationStatus: "verified",
    };
  }

  const now = Date.now();
  const recentRestarts = trimTimes(state.browserRestarts ?? [], now);
  if (recentRestarts.length >= MAX_GATEWAY_ACTIONS_PER_WINDOW) {
    state.browserRestarts = recentRestarts;
    return {
      system: "browser",
      status: "escalate",
      detail: "browser cdp unhealthy and restart budget already spent",
      verification: initial.detail,
      action: "none",
      verificationStatus: "uncertain",
      escalationPath: "page Hamel with browser/cdp failure and next action",
      policyLesson: "browser/cdp host restart budget is bounded; do not loop",
    };
  }

  const target = browserRelayLaunchTarget();
  const restart = target ? launchBrowserRelay(target.profileName, target.cdpUrl) : { ok: false, detail: "browser relay launch target unavailable" };
  recentRestarts.push(now);
  state.browserRestarts = recentRestarts;
  const verified = verifyBrowserCdp();
  if (!restart.ok || !verified.healthy) {
    return {
      system: "browser",
      status: "escalate",
      detail: "browser relay launch did not restore cdp health",
      verification: verified.detail,
      action: "open -na <Chrome> --args --remote-debugging-port=<port> --user-data-dir=~/.openclaw/browser/<profile>",
      verificationStatus: "uncertain",
      escalationPath: "page Hamel with browser/cdp failure and next action",
      policyLesson: "browser/cdp gets one bounded relay launch then escalates",
    };
  }

  return {
    system: "browser",
    status: "remediated",
    detail: "browser relay launched once and cdp health verified",
    verification: verified.detail,
    action: "open -na <Chrome> --args --remote-debugging-port=<port> --user-data-dir=~/.openclaw/browser/<profile>",
    verificationStatus: "verified",
    policyLesson: "browser/cdp recovery only counts after endpoint verification",
  };
}

function remediateVacationMode(): RemediationItem {
  const config = loadAutonomyConfig();
  const vacation = config.vacationMode;
  if (!vacation.enabled) {
    return {
      system: "vacation",
      status: "healthy",
      detail: "vacation mode disabled",
      verificationStatus: "verified",
    };
  }

  const jobsPath = path.join(os.homedir(), ".openclaw", "cron", "jobs.json");
  const quarantineDir = path.join(os.homedir(), ".openclaw", "cron", "quarantine");
  let jobsDoc: { jobs?: Array<{ name?: string; id?: string; enabled?: boolean; state?: { consecutiveErrors?: number }; updatedAtMs?: number }> } | null = null;
  try {
    jobsDoc = JSON.parse(fs.readFileSync(jobsPath, "utf8")) as typeof jobsDoc;
  } catch {
    jobsDoc = null;
  }

  if (!jobsDoc || !Array.isArray(jobsDoc.jobs)) {
    return {
      system: "vacation",
      status: "escalate",
      detail: "vacation mode enabled but runtime cron jobs unavailable",
      verificationStatus: "uncertain",
      escalationPath: "page Hamel with runtime cron state failure",
      policyLesson: "vacation mode cannot quarantine fragile jobs without runtime cron state",
    };
  }

  const threshold = Math.max(1, Number(vacation.quarantineAfterConsecutiveErrors || 1));
  const matchers = vacation.fragileCronMatchers.map((m) => m.toLowerCase());
  const quarantined: string[] = [];
  const now = Date.now();

  for (const job of jobsDoc.jobs) {
    if (job.enabled === false) continue;
    const name = String(job.name ?? "");
    if (!name) continue;
    const lower = name.toLowerCase();
    if (!matchers.some((matcher) => lower.includes(matcher))) continue;
    const consecutiveErrors = Number(job.state?.consecutiveErrors ?? 0);
    if (consecutiveErrors < threshold) continue;
    job.enabled = false;
    job.updatedAtMs = now;
    quarantined.push(name);
    try {
      fs.mkdirSync(quarantineDir, { recursive: true });
      const safeName = name.replace(/[\\/]/g, "_");
      fs.writeFileSync(path.join(quarantineDir, `${safeName}.quarantined`), `${new Date().toISOString()} vacation-mode fragile quarantine\n`, "utf8");
    } catch {
      // continue; write failures are handled by follow-up escalation if persistence fails below
    }
  }

  if (!quarantined.length) {
    return {
      system: "vacation",
      status: "healthy",
      detail: "vacation mode active; no fragile cron quarantines needed",
      verificationStatus: "verified",
    };
  }

  try {
    fs.writeFileSync(jobsPath, `${JSON.stringify(jobsDoc, null, 2)}\n`);
  } catch {
    return {
      system: "vacation",
      status: "escalate",
      detail: "vacation mode quarantine attempted but runtime cron state write failed",
      verificationStatus: "uncertain",
      escalationPath: "page Hamel with runtime write failure",
      policyLesson: "vacation mode quarantine must persist in runtime job state",
    };
  }

  return {
    system: "vacation",
    status: "remediated",
    detail: `vacation mode quarantined fragile cron jobs (${quarantined.slice(0, 3).join(", ")})`,
    verificationStatus: "verified",
    action: "runtime fragile cron quarantine",
    policyLesson: "vacation mode quarantines fragile jobs sooner to prevent noisy failure loops",
  };
}

function remediateRuntimeIntegrity(): RemediationItem {
  const check = runTs("tools/openclaw/runtime-integrity-check.ts", ["--json", "--repair"]);
  if (check.ok) {
    return {
      system: "runtime",
      status: "healthy",
      detail: "runtime integrity healthy",
      verification: check.stdout || "ok",
      verificationStatus: "verified",
    };
  }

  const parsed = parseJson(check.stdout);
  const failed = Array.isArray(parsed.results)
    ? parsed.results.filter((item: any) => item && item.ok === false)
    : [];
  const detail = failed.length
    ? failed.map((item: any) => `${item.name}: ${item.detail}`).join("; ")
    : (check.stderr || check.stdout || "runtime integrity degraded");
  const repaired = Array.isArray(parsed.results) && parsed.results.some((item: any) => item?.repaired && item?.ok);

  if (repaired) {
    return {
      system: "runtime",
      status: "remediated",
      detail: "runtime integrity repaired",
      verification: detail,
      action: "runtime-integrity-check --repair",
      verificationStatus: "verified",
      policyLesson: "runtime env drift should be repaired from durable gateway env sources before paging",
    };
  }

  return {
    system: "runtime",
    status: "escalate",
    detail: "runtime integrity degraded",
    verification: detail,
    action: "npx tsx tools/openclaw/runtime-integrity-check.ts --json --repair",
    verificationStatus: "uncertain",
    escalationPath: "page Hamel because runtime integrity remains degraded after bounded repair",
    policyLesson: "runtime/plugin/env integrity needs one bounded repair then escalation",
  };
}

function remediateGateway(state: StateShape): RemediationItem {
  const initial = gatewayHealthy();
  if (initial.healthy) {
    return { system: "gateway", status: "healthy", detail: "gateway reachable", verification: initial.detail, verificationStatus: "verified" };
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
      verificationStatus: "uncertain",
      escalationPath: "page Hamel with failing check + root cause + next action",
      policyLesson: "gateway restart budget is bounded; do not loop on control-plane recovery",
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
      verificationStatus: "uncertain",
      escalationPath: "page Hamel with failing check + root cause + next action",
      policyLesson: "one restart is enough; persistent gateway failure becomes an operator incident",
    };
  }

  return {
    system: "gateway",
    status: "remediated",
    detail: "gateway restarted once and verified healthy",
    verification: verified.detail,
    action: "openclaw gateway restart",
    verificationStatus: "verified",
    policyLesson: "bounded single-action recovery works when health is explicitly re-checked",
  };
}

function remediateChannel(state: StateShape): RemediationItem {
  const check = runTs("tools/alerting/check-cron-delivery.ts");
  if (check.ok) {
    return { system: "channel", status: "healthy", detail: "delivery path healthy", verification: check.stdout || "ok", verificationStatus: "verified" };
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
      verificationStatus: "uncertain",
      escalationPath: "page Hamel with delivery uncertainty and blocked personal reminders",
      policyLesson: "delivery paths get one bounded remediation attempt before paging",
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
      verificationStatus: "uncertain",
      escalationPath: "recover gateway first, then page if delivery remains uncertain",
      policyLesson: "delivery remediation should not mask a control-plane outage",
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
      verificationStatus: "uncertain",
      escalationPath: "page Hamel because verified delivery is still uncertain",
      policyLesson: "never-miss reminders should not stay in watch mode after a failed verification",
    };
  }

  return {
    system: "channel",
    status: "remediated",
    detail: "delivery degradation recovered after one restart",
    verification: verifyDelivery.stdout || "delivery check passed",
    action: "openclaw gateway restart",
    verificationStatus: "verified",
    policyLesson: "delivery recovery only counts after a post-action verification passes",
  };
}

function remediateSessionLifecycle(): RemediationItem {
  const session = runTs("tools/session/session-lifecycle-policy.ts", ["--json"]);
  const parsed = parseJson(session.stdout);
  const status = String(parsed.status ?? "unknown");

  if (status === "healthy") {
    return { system: "session", status: "healthy", detail: "session lifecycle within policy", verification: session.stdout || "ok", verificationStatus: "verified" };
  }

  if (status === "remediated") {
    return {
      system: "session",
      status: "remediated",
      detail: "session lifecycle breach cleaned up and verified",
      verification: session.stdout || "ok",
      action: "session cleanup --enforce",
      verificationStatus: "verified",
      policyLesson: "cleanup only counts when the post-cleanup policy check returns healthy/remediated",
    };
  }

  return {
    system: "session",
    status: "escalate",
    detail: "session lifecycle breach persists or cleanup failed",
    verification: session.stdout || session.stderr || "unknown",
    action: "manual session churn review",
    verificationStatus: "uncertain",
    escalationPath: "page Hamel with cleanup failure and active session risk",
    policyLesson: "stop after one cleanup pass when session churn remains abnormal",
  };
}

function remediateCriticalCron(): RemediationItem {
  const config = loadAutonomyConfig();
  const familyLane = config.familyCriticalLaneLabels.join(", ");
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
      familyCritical: true,
      laneLabel: familyLane,
      verificationStatus: retried > 0 ? "verified" : "uncertain",
      escalationPath: retried > 0 ? undefined : "page Hamel because family-critical cron auth remains unresolved",
      policyLesson: retried > 0 ? "auth recovery counts only after the guard verifies recovery" : "family-critical auth failures do not get repeated blind retries",
    };
  }

  const retry = runTs("tools/alerting/cron-auto-retry.ts", ["--critical-only", "--json"]);
  const parsed = parseJson(retry.stdout);
  const retried = Number(parsed.retried ?? 0);
  const failedAgain = Number(parsed.failedAgain ?? 0);
  const skipped = Number(parsed.skipped ?? 0);

  if (retried === 0 && skipped === 0) {
    return { system: "cron", status: "healthy", detail: "no actionable critical cron failures", verification: retry.stdout || "ok", familyCritical: true, laneLabel: familyLane, verificationStatus: "verified" };
  }

  if (failedAgain > 0 || skipped > 0) {
    return {
      system: "cron",
      status: "escalate",
      detail: "critical cron failures were repeated or non-transient; no looped retries",
      verification: retry.stdout || retry.stderr,
      action: retried > 0 ? "single critical cron retry" : "none",
      familyCritical: true,
      laneLabel: familyLane,
      verificationStatus: "uncertain",
      escalationPath: "page Hamel because family-critical delivery is still uncertain after one bounded retry",
      policyLesson: "appointments, calendar logistics, pregnancy reminders, and other never-miss reminders escalate after one failed verification path",
    };
  }

  return {
    system: "cron",
    status: "remediated",
    detail: "critical transient cron failures retried once and recovered",
    verification: retry.stdout,
    action: "single critical cron retry",
    familyCritical: true,
    laneLabel: familyLane,
    verificationStatus: "verified",
    policyLesson: "family-critical reminders recover quietly only after the retry confirms delivery is back",
  };
}

function createOrReuseFollowUp(item: RemediationItem): number | null {
  if (!['escalate', 'skipped'].includes(item.status)) return null;
  const system = sqlEscape(item.system);
  const detail = sqlEscape(item.detail);
  const action = sqlEscape(item.action ?? 'manual review');
  const urgency = item.familyCritical ? 'Family-critical' : 'Autonomy';
  const title = sqlEscape(`${urgency} follow-up: ${item.system} - ${item.detail}`.slice(0, 180));
  const description = sqlEscape(`${item.detail}\nLane: ${item.laneLabel ?? (item.familyCritical ? 'family-critical' : 'routine')}\nLatest verification: ${(item.verification ?? 'n/a').slice(0, 1200)}\nVerification status: ${item.verificationStatus ?? 'uncertain'}\nNext action: ${item.action ?? 'manual review'}\nEscalation path: ${item.escalationPath ?? 'review locally'}\nPolicy lesson: ${item.policyLesson ?? 'n/a'}`);
  const existing = psql(`
SELECT id::text
FROM cortana_tasks
WHERE status IN ('ready','in_progress')
  AND source = 'autonomy-remediation'
  AND metadata->>'followup_system' = '${system}'
ORDER BY created_at DESC
LIMIT 1;
`);
  if (existing) return Number(existing);
  const created = psql(`
INSERT INTO cortana_tasks (source, title, description, priority, status, auto_executable, execution_plan, metadata)
VALUES (
  'autonomy-remediation',
  '${title}',
  '${description}',
  ${item.familyCritical ? 1 : 2},
  'ready',
  FALSE,
  '${action}',
  jsonb_build_object(
    'followup_system', '${system}',
    'followup_status', '${item.status}',
    'family_critical', ${item.familyCritical ? 'true' : 'false'}
  )
)
RETURNING id::text;
`);
  return created ? Number(created) : null;
}

function latestStatusForSystem(system: string): string | null {
  const out = psql(`
SELECT COALESCE(metadata->>'status', '')
FROM cortana_events
WHERE source = 'autonomy-remediation'
  AND event_type = 'autonomy_action_result'
  AND metadata->>'system' = '${sqlEscape(system)}'
ORDER BY timestamp DESC
LIMIT 1;
`);
  return out || null;
}

function logActionResult(item: RemediationItem): RemediationItem {
  if (item.status === 'healthy') {
    resolveIncident(`remediation:${item.system}`, {
      source: "autonomy-remediation",
      summary: `${item.system} healthy`,
      detail: item.detail,
      remediationStatus: "verified",
      autoResolved: true,
      metadata: {
        verification_status: item.verificationStatus ?? "verified",
        lane_label: item.laneLabel ?? null,
      },
      observedAt: new Date().toISOString(),
      stateSource: "remediation",
    });
    return item;
  }

  const prior = latestStatusForSystem(item.system);
  if ((item.status === 'remediated') && (prior === 'escalate' || prior === 'skipped')) {
    psql(`
INSERT INTO cortana_events (event_type, source, severity, message, metadata)
VALUES (
  'autonomy_followup_suppressed',
  'autonomy-remediation',
  'info',
  'Suppressed stale autonomy follow-up after newer recovery',
  jsonb_build_object(
    'system', '${sqlEscape(item.system)}',
    'status', 'suppressed',
    'detail', '${sqlEscape(item.detail)}',
    'family_critical', ${item.familyCritical ? 'true' : 'false'},
    'lane_label', '${sqlEscape(item.laneLabel ?? (item.familyCritical ? 'family-critical' : 'routine'))}'
  )
);
`);
    item.freshnessSuppressed = true;
  }

  const followUpTaskId = createOrReuseFollowUp(item);
  item.followUpTaskId = followUpTaskId;
  const severity = item.status === 'remediated' ? 'info' : item.familyCritical ? 'error' : 'warning';
  const verification = sqlEscape((item.verification ?? '').slice(0, 2000));
  const action = sqlEscape(item.action ?? 'none');
  const escalationPath = sqlEscape(item.escalationPath ?? 'review locally');
  const policyLesson = sqlEscape(item.policyLesson ?? 'n/a');
  const laneLabel = sqlEscape(item.laneLabel ?? (item.familyCritical ? 'family-critical' : 'routine'));
  psql(`
INSERT INTO cortana_events (event_type, source, severity, message, metadata)
VALUES (
  'autonomy_action_result',
  'autonomy-remediation',
  '${severity}',
  '${sqlEscape(`${item.system} ${item.status}: ${item.detail}`)}',
  jsonb_build_object(
    'system', '${sqlEscape(item.system)}',
    'status', '${item.status}',
    'detail', '${sqlEscape(item.detail)}',
    'action', '${action}',
    'verification', '${verification}',
    'verification_status', '${item.verificationStatus ?? 'uncertain'}',
    'escalation_path', '${escalationPath}',
    'policy_lesson', '${policyLesson}',
    'family_critical', ${item.familyCritical ? 'true' : 'false'},
    'lane_label', '${laneLabel}',
    'followup_task_id', ${followUpTaskId ?? 'NULL'}
  )
);
`);

  const incidentKey = `remediation:${item.system}`;
  if (item.status === "escalate" || item.status === "skipped") {
    upsertOpenIncident({
      incidentKey,
      incidentType: "remediation",
      system: item.system,
      source: "autonomy-remediation",
      severity: item.status === "escalate" ? (item.familyCritical ? "error" : "warning") : "info",
      summary: `${item.system} ${item.status}`,
      detail: item.detail,
      remediationStatus: item.status,
      metadata: {
        family_critical: item.familyCritical ?? false,
        lane_label: item.laneLabel ?? null,
        verification_status: item.verificationStatus ?? "uncertain",
        followup_task_id: followUpTaskId,
      },
      observedAt: new Date().toISOString(),
      freshUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      stateSource: "remediation",
    });
  } else if (item.status === "remediated") {
    resolveIncident(incidentKey, {
      source: "autonomy-remediation",
      summary: `${item.system} remediated`,
      detail: item.detail,
      remediationStatus: "remediated",
      autoResolved: true,
      metadata: {
        verification_status: item.verificationStatus ?? "verified",
        lane_label: item.laneLabel ?? null,
      },
      observedAt: new Date().toISOString(),
      stateSource: "remediation",
    });
  }
  return item;
}

function main() {
  const state = readState();
  const config = loadAutonomyConfig();
  const items = [
    remediateGateway(state),
    remediateBrowser(state),
    remediateChannel(state),
    remediateCriticalCron(),
    remediateSessionLifecycle(),
    remediateRuntimeIntegrity(),
    remediateVacationMode(),
  ].map(logActionResult);
  writeState(state);

  const summary = {
    checkedAt: new Date().toISOString(),
    posture: config.posture,
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
