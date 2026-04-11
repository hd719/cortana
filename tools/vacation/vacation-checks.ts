import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { getMarketSessionInfo } from "../../skills/markets/check_market_status.ts";
import { externalRepoRoot, resolveRuntimeStatePath, sourceRepoRoot } from "../lib/paths.js";
import { runGogWithEnv } from "../gog/gog-with-env.js";
import type { VacationCheckResultRow, VacationCheckStatus, VacationOpsConfig } from "./types.js";

type RuntimeJob = {
  id?: string;
  name?: string;
  enabled?: boolean;
  schedule?: { expr?: string; tz?: string };
  state?: {
    lastRunAtMs?: number;
    lastStatus?: string;
    lastRunStatus?: string;
    lastDeliveryStatus?: string;
    consecutiveErrors?: number;
    nextRunAtMs?: number;
  };
};

export type VacationCheckEnvironment = {
  now?: () => Date;
  spawn?: typeof spawnSync;
  runtimeCronFile?: string;
  mainSessionStore?: string;
  monitorSessionStore?: string;
  missionControlUrl?: string;
  marketDataBaseUrl?: string;
};

function nowIso(env: VacationCheckEnvironment): string {
  return (env.now ?? (() => new Date()))().toISOString();
}

function execResult(proc: SpawnSyncReturns<string>) {
  return {
    status: proc.status ?? 1,
    stdout: String(proc.stdout ?? ""),
    stderr: String(proc.stderr ?? ""),
    error: proc.error,
  };
}

function run(env: VacationCheckEnvironment, cmd: string, args: string[]): ReturnType<typeof execResult> {
  const proc = (env.spawn ?? spawnSync)(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return execResult(proc);
}

function compact(text: string, max = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "unknown";
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function currentTime(env: VacationCheckEnvironment): Date {
  return (env.now ?? (() => new Date()))();
}

function buildResult(
  config: VacationOpsConfig,
  systemKey: string,
  status: VacationCheckStatus,
  detail: Record<string, unknown>,
  freshnessAt?: string | null,
): VacationCheckResultRow {
  return {
    system_key: systemKey,
    tier: config.systems[systemKey]?.tier ?? 3,
    status,
    observed_at: new Date().toISOString(),
    freshness_at: freshnessAt ?? null,
    detail,
  };
}

function minutesBeforeNextMarketOpen(now: Date): number | null {
  const session = getMarketSessionInfo(now);
  if (session.phase === "OPEN") return 0;
  const maxLookaheadMinutes = 7 * 24 * 60;
  for (let offset = 1; offset <= maxLookaheadMinutes; offset += 1) {
    const candidate = new Date(now.getTime() + offset * 60 * 1000);
    if (getMarketSessionInfo(candidate).phase === "OPEN") {
      return offset;
    }
  }
  return null;
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function readRuntimeJob(env: VacationCheckEnvironment, name: string): RuntimeJob | null {
  const runtimeCronFile = env.runtimeCronFile ?? resolveRuntimeStatePath("cron", "jobs.json");
  const doc = readJson<{ jobs?: RuntimeJob[] }>(runtimeCronFile);
  if (!doc?.jobs) return null;
  return doc.jobs.find((job) => String(job.name ?? "") === name) ?? null;
}

function cronCheck(config: VacationOpsConfig, env: VacationCheckEnvironment, systemKey: string, name: string): VacationCheckResultRow {
  const job = readRuntimeJob(env, name);
  if (!job) return buildResult(config, systemKey, "red", { reason: "runtime_job_missing", jobName: name });
  const state = job.state ?? {};
  const lastRunAtMs = Number(state.lastRunAtMs ?? 0);
  const freshnessAt = lastRunAtMs > 0 ? new Date(lastRunAtMs).toISOString() : null;
  const lastStatus = String(state.lastRunStatus ?? state.lastStatus ?? "").toLowerCase();
  const lastDeliveryStatus = String(state.lastDeliveryStatus ?? "").toLowerCase();
  const consecutiveFailures = Number(state.consecutiveErrors ?? 0);
  const ok = Boolean(job.enabled !== false) && !["error", "failed"].includes(lastStatus) && !["error", "failed"].includes(lastDeliveryStatus);
  return buildResult(config, systemKey, ok ? "green" : "red", {
    jobName: name,
    enabled: job.enabled !== false,
    lastStatus,
    lastDeliveryStatus,
    consecutiveFailures,
    nextRunAtMs: Number(state.nextRunAtMs ?? 0) || null,
  }, freshnessAt);
}

function sessionCheck(config: VacationOpsConfig, systemKey: string, storePath: string, prefix: string): VacationCheckResultRow {
  const parsed = readJson<Record<string, unknown>>(storePath);
  if (!parsed) return buildResult(config, systemKey, "red", { reason: "session_store_unreadable", storePath });
  const keys = Object.keys(parsed);
  const matched = keys.filter((key) => key === prefix || key.startsWith(`${prefix}:telegram:`) || key.startsWith(`${prefix}:main`));
  return buildResult(config, systemKey, matched.length > 0 ? "green" : "red", {
    storePath,
    matchedKeys: matched,
    totalKeys: keys.length,
  });
}

function httpProbe(env: VacationCheckEnvironment, url: string): { ok: boolean; detail: Record<string, unknown>; freshnessAt: string } {
  const result = run(env, "curl", ["-sS", "--max-time", "8", url]);
  const observedAt = nowIso(env);
  if (result.status !== 0) {
    return {
      ok: false,
      detail: { url, error: compact(result.stderr || result.stdout || result.error?.message || "curl failed") },
      freshnessAt: observedAt,
    };
  }

  try {
    const payload = JSON.parse(result.stdout || "{}") as Record<string, unknown>;
    const status = String(payload.status ?? "");
    const ok = payload.ok !== false && !["missed", "unknown", "unhealthy", "error"].includes(status.toLowerCase());
    return {
      ok,
      detail: { url, payload },
      freshnessAt: observedAt,
    };
  } catch {
    return {
      ok: false,
      detail: { url, error: "invalid_json", body: compact(result.stdout) },
      freshnessAt: observedAt,
    };
  }
}

function checkGateway(config: VacationOpsConfig, env: VacationCheckEnvironment): VacationCheckResultRow {
  const result = run(env, "openclaw", ["gateway", "status", "--no-probe"]);
  return buildResult(config, "gateway_service", result.status === 0 ? "green" : "red", {
    command: "openclaw gateway status --no-probe",
    detail: compact(result.stderr || result.stdout || "gateway unavailable"),
  });
}

function checkTelegramDelivery(config: VacationOpsConfig, env: VacationCheckEnvironment): VacationCheckResultRow {
  const jsonStatus = run(env, "openclaw", ["status", "--json"]);
  const textStatus = run(env, "openclaw", ["status"]);
  const merged = `${jsonStatus.stdout}\n${jsonStatus.stderr}\n${textStatus.stdout}\n${textStatus.stderr}`;
  const ok = jsonStatus.status === 0 && textStatus.status === 0 && /Telegram:\s*configured/i.test(jsonStatus.stdout || "") && /Telegram[^\n]*(?:OK|configured)/i.test(merged);
  return buildResult(config, "telegram_delivery", ok ? "green" : "red", {
    detail: compact(merged),
  });
}

function checkMissionControl(config: VacationOpsConfig, env: VacationCheckEnvironment): VacationCheckResultRow {
  const probe = httpProbe(env, env.missionControlUrl ?? "http://127.0.0.1:3000/api/heartbeat-status");
  return buildResult(config, "mission_control", probe.ok ? "green" : "red", probe.detail, probe.freshnessAt);
}

function checkTailscale(config: VacationOpsConfig, env: VacationCheckEnvironment): VacationCheckResultRow {
  const status = run(env, "tailscale", ["status", "--json"]);
  const ip = run(env, "tailscale", ["ip", "-4"]);
  if (status.status !== 0 || ip.status !== 0) {
    return buildResult(config, "tailscale_remote_access", "red", {
      status: compact(status.stderr || status.stdout),
      ip: compact(ip.stderr || ip.stdout),
    });
  }

  try {
    const parsed = JSON.parse(status.stdout || "{}") as { BackendState?: string };
    const backendState = String(parsed.BackendState ?? "");
    const ok = backendState.toLowerCase() === "running" && ip.stdout.trim().length > 0;
    return buildResult(config, "tailscale_remote_access", ok ? "green" : "red", {
      backendState,
      ip: ip.stdout.trim(),
    });
  } catch {
    return buildResult(config, "tailscale_remote_access", "red", {
      error: "invalid_json",
      detail: compact(status.stdout),
    });
  }
}

function checkRuntimeIntegrity(config: VacationOpsConfig, env: VacationCheckEnvironment): VacationCheckResultRow {
  const result = run(env, "npx", ["tsx", path.join(sourceRepoRoot(), "tools", "openclaw", "runtime-integrity-check.ts"), "--json"]);
  if (result.status !== 0 && !(result.stdout || "").trim()) {
    return buildResult(config, "runtime_integrity", "red", { detail: compact(result.stderr || result.error?.message || "runtime integrity failed") });
  }

  try {
    const parsed = JSON.parse(result.stdout || "{}") as { overall_ok?: boolean };
    return buildResult(config, "runtime_integrity", parsed.overall_ok ? "green" : "red", { payload: parsed });
  } catch {
    return buildResult(config, "runtime_integrity", "red", { detail: compact(result.stdout || result.stderr) });
  }
}

function checkGreenBaseline(config: VacationOpsConfig, env: VacationCheckEnvironment): VacationCheckResultRow {
  const result = run(env, "bash", [path.join(sourceRepoRoot(), "tools", "qa", "green-baseline.sh")]);
  const ok = result.status === 0 && /GREEN_BASELINE=ok/i.test(result.stdout);
  return buildResult(config, "green_baseline", ok ? "green" : "red", {
    detail: compact(result.stdout || result.stderr),
  });
}

function checkCriticalSyntheticProbe(config: VacationOpsConfig, env: VacationCheckEnvironment): VacationCheckResultRow {
  const result = run(env, "npx", ["tsx", path.join(sourceRepoRoot(), "tools", "monitoring", "critical-synthetic-probe.ts")]);
  const stdout = (result.stdout || "").trim();
  const ok = result.status === 0 && stdout === "NO_REPLY";
  return buildResult(config, "critical_synthetic_probe", ok ? "green" : "red", {
    detail: compact(stdout || result.stderr || "probe failed"),
  });
}

function checkGogHeadlessAuth(config: VacationOpsConfig): VacationCheckResultRow {
  const result = execResult(runGogWithEnv(["auth", "list", "--json", "--no-input"]));
  return buildResult(config, "gog_headless_auth", result.status === 0 ? "green" : "red", {
    detail: compact(result.stderr || result.stdout),
  });
}

function checkGmailInbox(config: VacationOpsConfig): VacationCheckResultRow {
  const result = execResult(runGogWithEnv(["--account", process.env.GOG_ACCOUNT ?? "hameldesai3@gmail.com", "gmail", "search", "in:inbox", "--max", "1", "--json"]));
  return buildResult(config, "gmail_inbox_triage", result.status === 0 ? "green" : "red", {
    detail: compact(result.stderr || result.stdout),
  });
}

function checkFitnessService(config: VacationOpsConfig, env: VacationCheckEnvironment): VacationCheckResultRow {
  const probe = httpProbe(env, `${env.marketDataBaseUrl ?? "http://127.0.0.1:3033"}/health`);
  const payload = (probe.detail.payload ?? {}) as Record<string, unknown>;
  const ok = probe.ok && String(payload.status ?? "ok").toLowerCase() !== "unhealthy";
  return buildResult(config, "fitness_service", ok ? "green" : "red", probe.detail, probe.freshnessAt);
}

function checkSchwabQuoteSmoke(config: VacationOpsConfig, env: VacationCheckEnvironment): VacationCheckResultRow {
  const base = env.marketDataBaseUrl ?? "http://127.0.0.1:3033";
  const ready = httpProbe(env, `${base}/market-data/ready`);
  const quote = httpProbe(env, `${base}/market-data/quote/SPY`);
  const ok = ready.ok && quote.ok;
  return buildResult(config, "schwab_quote_smoke", ok ? "green" : "red", {
    ready: ready.detail,
    quote: quote.detail,
  }, quote.freshnessAt);
}

function checkBacktesterApp(config: VacationOpsConfig, env: VacationCheckEnvironment): VacationCheckResultRow {
  const readinessPath = path.join(externalRepoRoot(), "backtester", "var", "readiness", "pre-open-canary-latest.json");
  const readiness = readJson<Record<string, unknown>>(readinessPath);
  const ready = httpProbe(env, `${env.marketDataBaseUrl ?? "http://127.0.0.1:3033"}/market-data/ready`);
  const ok = ready.ok && Boolean(readiness);
  return buildResult(config, "backtester_app", ok ? "green" : "red", {
    readinessPath,
    readiness,
    readyProbe: ready.detail,
  }, readiness && typeof readiness.checked_at === "string" ? String(readiness.checked_at) : ready.freshnessAt);
}

function checkGithubIdentity(config: VacationOpsConfig, env: VacationCheckEnvironment): VacationCheckResultRow {
  const result = run(env, "gh", ["auth", "status"]);
  const ok = result.status === 0 && /Logged in|github\.com/i.test(result.stdout || result.stderr);
  return buildResult(config, "github_identity", ok ? "green" : "red", {
    detail: compact(result.stdout || result.stderr),
  });
}

function checkBrowserCdp(config: VacationOpsConfig, env: VacationCheckEnvironment): VacationCheckResultRow {
  const result = run(env, "npx", ["tsx", path.join(sourceRepoRoot(), "tools", "monitoring", "browser-cdp-watchdog.ts")]);
  const stdout = (result.stdout || "").trim();
  const ok = result.status === 0 && stdout === "NO_REPLY";
  return buildResult(config, "browser_cdp", ok ? "green" : "red", {
    detail: compact(stdout || result.stderr),
  });
}

function marketTier2Check(config: VacationOpsConfig, env: VacationCheckEnvironment, systemKey: string, name: string): VacationCheckResultRow {
  const base = cronCheck(config, env, systemKey, name);
  const now = currentTime(env);
  const session = getMarketSessionInfo(now);
  const staleHours = base.freshness_at ? (now.getTime() - Date.parse(base.freshness_at)) / (1000 * 60 * 60) : null;
  return {
    ...base,
    detail: {
      ...base.detail,
      consecutiveFailures: Number(base.detail.consecutiveFailures ?? 0),
      marketHours: session.phase === "OPEN",
      marketPhase: session.phase,
      marketSessionLabel: session.label,
      staleHours,
      staleMinutes: staleHours == null ? null : staleHours * 60,
      minutesBeforeNextOpen: minutesBeforeNextMarketOpen(now),
    },
  };
}

export function runSystemCheck(config: VacationOpsConfig, env: VacationCheckEnvironment, systemKey: string): VacationCheckResultRow {
  const mainStore = env.mainSessionStore ?? path.join(os.homedir(), ".openclaw", "agents", "main", "sessions", "sessions.json");
  const monitorStore = env.monitorSessionStore ?? path.join(os.homedir(), ".openclaw", "agents", "monitor", "sessions", "sessions.json");
  switch (systemKey) {
    case "gateway_service":
      return checkGateway(config, env);
    case "telegram_delivery":
      return checkTelegramDelivery(config, env);
    case "main_agent_delivery":
      return sessionCheck(config, systemKey, mainStore, "agent:main");
    case "monitor_agent_delivery":
      return sessionCheck(config, systemKey, monitorStore, "agent:monitor");
    case "mission_control":
      return checkMissionControl(config, env);
    case "tailscale_remote_access":
      return checkTailscale(config, env);
    case "runtime_integrity":
      return checkRuntimeIntegrity(config, env);
    case "green_baseline":
      return checkGreenBaseline(config, env);
    case "critical_synthetic_probe":
      return checkCriticalSyntheticProbe(config, env);
    case "gog_headless_auth":
      return checkGogHeadlessAuth(config);
    case "calendar_reminders_e2e":
      return cronCheck(config, env, systemKey, "📅 Calendar reminders → Telegram (ALL calendars)");
    case "apple_reminders_e2e":
      return cronCheck(config, env, systemKey, "⏰ Apple Reminders alerts → Telegram (Monitor)");
    case "morning_brief_e2e":
      return cronCheck(config, env, systemKey, "☀️ Morning brief (Hamel)");
    case "gmail_inbox_triage":
      return checkGmailInbox(config);
    case "fitness_service":
      return checkFitnessService(config, env);
    case "schwab_quote_smoke":
      return checkSchwabQuoteSmoke(config, env);
    case "backtester_app":
      return checkBacktesterApp(config, env);
    case "github_identity":
      return checkGithubIdentity(config, env);
    case "browser_cdp":
      return checkBrowserCdp(config, env);
    case "market_scans":
      return marketTier2Check(config, env, systemKey, "📈 Stock Market Brief (daily)");
    case "trading_watchlist_refresh":
      return marketTier2Check(config, env, systemKey, "📈 Stock Market Brief (collect)");
    case "secondary_dashboard_enrichments": {
      const probe = httpProbe(env, env.missionControlUrl ?? "http://127.0.0.1:3000/api/heartbeat-status");
      return buildResult(config, systemKey, probe.ok ? "green" : "yellow", probe.detail, probe.freshnessAt);
    }
    case "low_value_info_scans":
      return buildResult(config, systemKey, "info", { detail: "informational tier only" });
    default:
      return buildResult(config, systemKey, "fail", { reason: "unknown_system_key" });
  }
}

export function runVacationChecks(config: VacationOpsConfig, env: VacationCheckEnvironment = {}, systemKeys?: string[]): VacationCheckResultRow[] {
  const keys = systemKeys ?? Object.keys(config.systems);
  return keys.map((key) => runSystemCheck(config, env, key));
}
