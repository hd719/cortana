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

type CronRunEntry = {
  ts?: number;
  action?: string;
  status?: string;
  nextRunAtMs?: number;
  deliveryStatus?: string;
};

type LanesConfig = {
  familyCriticalCronNames?: string[];
};

type SessionStoreEntry = {
  updatedAt?: string | number;
  sessionId?: string;
  sessionFile?: string;
  status?: string;
  outcome?: { status?: string } | string;
  result?: unknown;
  done?: boolean;
};

export type VacationCheckEnvironment = {
  now?: () => Date;
  spawn?: typeof spawnSync;
  gogAuthList?: () => {
    status: number;
    stdout: string;
    stderr: string;
    error?: unknown;
  };
  runtimeCronFile?: string;
  runtimeCronRunsDir?: string;
  lanesConfigFile?: string;
  mainSessionStore?: string;
  monitorSessionStore?: string;
  missionControlUrl?: string;
  marketDataBaseUrl?: string;
};

const CRITICAL_CRON_OVERDUE_MS = 60 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 20_000;

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
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return execResult(proc);
}

function compact(text: string, max = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "unknown";
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function redactToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const normalized = token.trim();
  if (!normalized) return null;
  if (normalized.includes("*")) return normalized;
  if (normalized.length <= 8) return `${normalized.slice(0, 2)}****`;
  return `${normalized.slice(0, 4)}${"*".repeat(Math.max(8, normalized.length - 8))}${normalized.slice(-4)}`;
}

function parseQuotedList(text: string): string[] {
  return Array.from(text.matchAll(/'([^']+)'/g), (match) => match[1]).filter(Boolean);
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

function readRuntimeJobs(env: VacationCheckEnvironment): RuntimeJob[] {
  const runtimeCronFile = env.runtimeCronFile ?? resolveRuntimeStatePath("cron", "jobs.json");
  const doc = readJson<{ jobs?: RuntimeJob[] }>(runtimeCronFile);
  return Array.isArray(doc?.jobs) ? doc.jobs : [];
}

function readLatestCronRun(env: VacationCheckEnvironment, jobId: string | undefined): CronRunEntry | null {
  if (!jobId) return null;
  const runPath = path.join(env.runtimeCronRunsDir ?? resolveRuntimeStatePath("cron", "runs"), `${jobId}.jsonl`);
  try {
    const raw = fs.readFileSync(runPath, "utf8").trim();
    if (!raw) return null;
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]?.trim();
      if (!line) continue;
      const parsed = JSON.parse(line) as CronRunEntry;
      if (parsed?.action === "finished") return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

function parseTimestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function isFailedStatus(value: string): boolean {
  return ["error", "failed"].includes(value);
}

function isAcceptableDeliveryStatus(value: string): boolean {
  return [
    "ok",
    "delivered",
    "not-delivered",
    "not-requested",
    "no_reply",
    "no-reply",
  ].includes(value);
}

function hasPositiveCompletionEvidence(entry: SessionStoreEntry): boolean {
  const directStatus = String(entry.status ?? "").trim().toLowerCase();
  if (["completed", "done", "success", "succeeded", "ok"].includes(directStatus)) return true;

  if (typeof entry.outcome === "string") {
    const outcomeStatus = entry.outcome.trim().toLowerCase();
    if (["completed", "done", "success", "succeeded", "ok"].includes(outcomeStatus)) return true;
  }

  if (entry.outcome && typeof entry.outcome === "object") {
    const outcomeStatus = String(entry.outcome.status ?? "").trim().toLowerCase();
    if (["completed", "done", "success", "succeeded", "ok"].includes(outcomeStatus)) return true;
  }

  if (entry.result != null) {
    if (typeof entry.result === "string" && entry.result.trim()) return true;
    if (typeof entry.result === "object" && Object.keys(entry.result as Record<string, unknown>).length > 0) return true;
  }

  return entry.done === true;
}

function resolveSessionArtifactPath(storePath: string, entry: SessionStoreEntry): string | null {
  if (typeof entry.sessionFile === "string" && entry.sessionFile.trim()) {
    return path.isAbsolute(entry.sessionFile) ? entry.sessionFile : path.resolve(path.dirname(storePath), entry.sessionFile);
  }
  if (typeof entry.sessionId === "string" && entry.sessionId.trim()) {
    return path.join(path.dirname(storePath), `${entry.sessionId}.jsonl`);
  }
  return null;
}

function readCriticalCronDeliveryEvidence(config: VacationOpsConfig, env: VacationCheckEnvironment): {
  ok: boolean;
  freshnessAt: string | null;
  detail: Record<string, unknown>;
} {
  const jobs = readRuntimeJobs(env);
  if (!jobs.length) {
    return {
      ok: false,
      freshnessAt: null,
      detail: { reason: "runtime_jobs_unavailable" },
    };
  }

  const lanes = readJson<LanesConfig>(env.lanesConfigFile ?? path.join(sourceRepoRoot(), "config", "autonomy-lanes.json"));
  const criticalNames = (lanes?.familyCriticalCronNames ?? []).map((name) => String(name)).filter(Boolean);
  if (!criticalNames.length) {
    return {
      ok: false,
      freshnessAt: null,
      detail: { reason: "critical_cron_names_missing" },
    };
  }

  const nowMs = currentTime(env).getTime();
  const matchedJobs = criticalNames
    .map((name) => jobs.find((job) => String(job.name ?? "") === name) ?? null)
    .filter((job): job is RuntimeJob => Boolean(job));
  const missingJobs = criticalNames.filter((name) => !matchedJobs.some((job) => String(job.name ?? "") === name));

  if (!matchedJobs.length) {
    return {
      ok: false,
      freshnessAt: null,
      detail: { reason: "critical_cron_jobs_missing", missingJobs },
    };
  }

  const evaluations = matchedJobs.map((job) => {
    const latestRun = readLatestCronRun(env, job.id);
    const latestRunTs = parseTimestampMs(latestRun?.ts);
    const stateLastRunAtMs = Number(job.state?.lastRunAtMs ?? 0);
    const useLatestRun = latestRunTs > 0 && latestRunTs >= stateLastRunAtMs;
    const lastObservedAtMs = useLatestRun ? latestRunTs : stateLastRunAtMs;
    const nextRunAtMs = parseTimestampMs(useLatestRun ? latestRun?.nextRunAtMs : job.state?.nextRunAtMs);
    const overdue = nextRunAtMs > 0 && nowMs - nextRunAtMs > CRITICAL_CRON_OVERDUE_MS;
    const lastStatus = String((useLatestRun ? latestRun?.status : job.state?.lastRunStatus ?? job.state?.lastStatus) ?? "").toLowerCase();
    const lastDeliveryStatus = String((useLatestRun ? latestRun?.deliveryStatus : job.state?.lastDeliveryStatus) ?? "").toLowerCase();
    const consecutiveErrors = Number(job.state?.consecutiveErrors ?? 0);
    const hasDeliveryEvidence = lastObservedAtMs > 0 && isAcceptableDeliveryStatus(lastDeliveryStatus);
    const deliveryFailed = isFailedStatus(lastDeliveryStatus);
    const ok = job.enabled !== false
      && hasDeliveryEvidence
      && !overdue
      && consecutiveErrors < 2
      && !isFailedStatus(lastStatus)
      && !deliveryFailed;

    return {
      jobId: job.id ?? null,
      jobName: String(job.name ?? "unknown"),
      enabled: job.enabled !== false,
      evidenceSource: useLatestRun ? "run_ledger" : "runtime_state",
      observedAt: lastObservedAtMs > 0 ? new Date(lastObservedAtMs).toISOString() : null,
      nextRunAt: nextRunAtMs > 0 ? new Date(nextRunAtMs).toISOString() : null,
      overdue,
      lastStatus,
      lastDeliveryStatus,
      consecutiveErrors,
      hasDeliveryEvidence,
      ok,
    };
  });

  const healthyEvidence = evaluations
    .filter((item) => item.ok)
    .sort((a, b) => Date.parse(String(b.observedAt ?? 0)) - Date.parse(String(a.observedAt ?? 0)));

  if (!healthyEvidence.length) {
    return {
      ok: false,
      freshnessAt: null,
      detail: {
        reason: "critical_cron_delivery_unverified",
        missingJobs,
        evaluatedJobs: evaluations,
      },
    };
  }

  return {
    ok: true,
    freshnessAt: healthyEvidence[0]?.observedAt ?? null,
    detail: {
      evidenceJob: healthyEvidence[0],
      missingJobs,
      evaluatedJobs: evaluations,
    },
  };
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

function sessionCheck(config: VacationOpsConfig, env: VacationCheckEnvironment, systemKey: string, storePath: string, prefix: string): VacationCheckResultRow {
  const parsed = readJson<Record<string, SessionStoreEntry>>(storePath);
  if (!parsed) return buildResult(config, systemKey, "red", { reason: "session_store_unreadable", storePath });
  const keys = Object.keys(parsed);
  const matched = keys.filter((key) => key === prefix || key.startsWith(`${prefix}:`));
  if (!matched.length) {
    return buildResult(config, systemKey, "red", {
      reason: "session_key_missing",
      storePath,
      totalKeys: keys.length,
    });
  }

  const freshnessMs = config.readinessFreshnessHours * 60 * 60 * 1000;
  const nowMs = currentTime(env).getTime();
  const evidence = matched
    .map((key) => {
      const entry = parsed[key] ?? {};
      const updatedAtMs = parseTimestampMs(entry.updatedAt);
      const sessionFile = resolveSessionArtifactPath(storePath, entry);
      const exists = Boolean(sessionFile && fs.existsSync(sessionFile));
      const sizeBytes = exists && sessionFile ? fs.statSync(sessionFile).size : 0;
      return {
        key,
        updatedAt: updatedAtMs > 0 ? new Date(updatedAtMs).toISOString() : null,
        updatedAtMs,
        fresh: updatedAtMs > 0 && nowMs - updatedAtMs <= freshnessMs,
        sessionFile,
        sessionFileExists: exists,
        sessionFileSizeBytes: sizeBytes,
        positiveCompletionEvidence: hasPositiveCompletionEvidence(entry),
      };
    })
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);

  const verified = evidence.find((entry) => entry.fresh && entry.sessionFileExists && entry.sessionFileSizeBytes > 0) ?? null;
  return buildResult(config, systemKey, verified ? "green" : "red", {
    storePath,
    matchedKeys: matched,
    verifiedSession: verified,
    latestSession: evidence[0] ?? null,
    missingArtifactKeys: evidence.filter((entry) => !entry.sessionFileExists || entry.sessionFileSizeBytes <= 0).map((entry) => entry.key),
    staleKeys: evidence.filter((entry) => !entry.fresh).map((entry) => entry.key),
    totalKeys: keys.length,
  }, verified?.updatedAt ?? evidence[0]?.updatedAt ?? null);
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

function summarizeProviderStatus(label: string, status: string, extra?: string | null): string {
  return extra ? `${label}: ${status} (${extra})` : `${label}: ${status}`;
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
  const transportConfigured = /Telegram:\s*configured/i.test(jsonStatus.stdout || "") && /Telegram[^\n]*(?:OK|configured)/i.test(merged);
  const deliveryEvidence = readCriticalCronDeliveryEvidence(config, env);
  const ok = jsonStatus.status === 0 && textStatus.status === 0 && transportConfigured && deliveryEvidence.ok;
  return buildResult(config, "telegram_delivery", ok ? "green" : "red", {
    transportConfigured,
    statusDetail: compact(merged),
    deliveryEvidence: deliveryEvidence.detail,
  }, deliveryEvidence.freshnessAt);
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
  const result = run(env, "bash", [path.join(sourceRepoRoot(), "tools", "qa", "green-baseline.sh"), "--skip-git"]);
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

function checkGogHeadlessAuth(config: VacationOpsConfig, env: VacationCheckEnvironment): VacationCheckResultRow {
  const result = env.gogAuthList?.() ?? execResult(runGogWithEnv(["auth", "list", "--json", "--no-input"]));
  if (result.status !== 0) {
    return buildResult(config, "gog_headless_auth", "red", {
      detail: compact(result.stderr || result.stdout),
      raw: compact(result.stdout || result.stderr, 600),
    });
  }

  try {
    const parsed = JSON.parse(result.stdout || "{}") as {
      accounts?: Array<{
        email?: string;
        client?: string;
        services?: string[];
        scopes?: string[];
        created_at?: string;
        auth?: string;
      }>;
    };
    const accounts = (parsed.accounts ?? []).map((account) => ({
      email: String(account.email ?? "unknown"),
      client: String(account.client ?? "unknown"),
      services: Array.isArray(account.services) ? account.services.map((service) => String(service)) : [],
      scopes: Array.isArray(account.scopes) ? account.scopes.map((scope) => String(scope)) : [],
      createdAt: typeof account.created_at === "string" ? account.created_at : null,
      auth: typeof account.auth === "string" ? account.auth : null,
    }));
    const primary = accounts[0] ?? null;
    return buildResult(config, "gog_headless_auth", "green", {
      summary: primary
        ? `${primary.email} · ${primary.services.join(", ") || "no services"}`
        : "No Gog accounts returned",
      accountCount: accounts.length,
      accounts,
    });
  } catch {
    return buildResult(config, "gog_headless_auth", "red", {
      detail: "invalid_json",
      raw: compact(result.stdout || result.stderr, 600),
    });
  }
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
  const result = run(env, "gh", ["auth", "status", "--show-token"]);
  const merged = `${result.stdout}\n${result.stderr}`.trim();
  const safeMerged = merged.replace(/(Token:\s*)([^\n]+)/i, (_, prefix: string, token: string) => `${prefix}${redactToken(token) ?? "unknown"}`);
  const host = merged.match(/^(github\.com)$/m)?.[1] ?? "github.com";
  const accountMatch = merged.match(/Logged in to [^\s]+ account ([^\s]+) \(([^)]+)\)/);
  const activeMatch = merged.match(/Active account:\s*(true|false)/i);
  const protocolMatch = merged.match(/Git operations protocol:\s*([^\n]+)/i);
  const tokenMatch = merged.match(/Token:\s*([^\n]+)/i);
  const scopesMatch = merged.match(/Token scopes:\s*([^\n]+)/i);

  const detail = {
    host,
    account: accountMatch?.[1] ?? null,
    configPath: accountMatch?.[2] ?? null,
    activeAccount: activeMatch ? activeMatch[1].toLowerCase() === "true" : null,
    gitProtocol: protocolMatch?.[1]?.trim() ?? null,
    tokenRedacted: redactToken(tokenMatch?.[1] ?? null),
    scopes: parseQuotedList(scopesMatch?.[1] ?? ""),
    summary: accountMatch?.[1]
      ? `${accountMatch[1]} · ${protocolMatch?.[1]?.trim() ?? "unknown protocol"} · ${parseQuotedList(scopesMatch?.[1] ?? "").length} scopes`
      : compact(safeMerged),
  };
  const ok = result.status === 0 && Boolean(detail.account);
  return buildResult(config, "github_identity", ok ? "green" : "red", {
    ...detail,
    detail: compact(safeMerged),
  });
}

function checkFinancialExternalServices(config: VacationOpsConfig, env: VacationCheckEnvironment): VacationCheckResultRow {
  const baseUrl = env.marketDataBaseUrl ?? "http://127.0.0.1:3033";
  const alpaca = httpProbe(env, `${baseUrl}/alpaca/health`);
  const marketOps = httpProbe(env, `${baseUrl}/market-data/ops`);
  const observedAt = marketOps.freshnessAt || alpaca.freshnessAt || nowIso(env);

  const marketOpsPayload = ((marketOps.detail.payload ?? {}) as Record<string, unknown>);
  const providers = ((((marketOpsPayload.data ?? {}) as Record<string, unknown>).health ?? {}) as Record<string, unknown>).providers as Record<string, unknown> | undefined;
  const coinMarketCapStatus = typeof providers?.coinmarketcap === "string" ? providers.coinmarketcap : "unknown";
  const fredStatus = typeof providers?.fred === "string" ? providers.fred : "unknown";
  const alpacaPayload = (alpaca.detail.payload ?? {}) as Record<string, unknown>;
  const alpacaServiceStatus = typeof alpacaPayload.status === "string" ? alpacaPayload.status : (alpaca.ok ? "ok" : "unhealthy");
  const alpacaDetail = typeof alpacaPayload.error === "string"
    ? compact(alpacaPayload.error, 180)
    : typeof alpaca.detail.error === "string"
      ? compact(alpaca.detail.error, 180)
      : null;

  const services = [
    {
      key: "alpaca",
      label: "Alpaca",
      status: alpaca.ok ? "green" : "yellow",
      summary: summarizeProviderStatus("Alpaca", alpaca.ok ? "healthy" : "degraded", alpacaDetail),
      freshnessAt: alpaca.freshnessAt,
      detail: {
        status: alpacaServiceStatus,
        error: alpacaDetail,
      },
    },
    {
      key: "coinmarketcap",
      label: "CoinMarketCap",
      status: coinMarketCapStatus === "configured" ? "green" : "yellow",
      summary: summarizeProviderStatus("CoinMarketCap", coinMarketCapStatus),
      freshnessAt: marketOps.freshnessAt,
      detail: {
        status: coinMarketCapStatus,
      },
    },
    {
      key: "fred",
      label: "FRED",
      status: fredStatus === "configured" ? "green" : "yellow",
      summary: summarizeProviderStatus("FRED", fredStatus),
      freshnessAt: marketOps.freshnessAt,
      detail: {
        status: fredStatus,
      },
    },
  ];

  const degraded = services.filter((service) => service.status !== "green");
  const status = !marketOps.ok
    ? "red"
    : degraded.length > 0
      ? "yellow"
      : "green";

  return buildResult(config, "financial_external_services", status, {
    summary: degraded.length > 0
      ? degraded.map((service) => service.summary).join(" · ")
      : "Alpaca, CoinMarketCap, and FRED are healthy or configured.",
    services,
    marketDataOps: {
      status: typeof marketOpsPayload.status === "string" ? marketOpsPayload.status : "unknown",
      providerMode: typeof marketOpsPayload.providerMode === "string" ? marketOpsPayload.providerMode : null,
      providerModeReason: typeof marketOpsPayload.providerModeReason === "string" ? marketOpsPayload.providerModeReason : null,
      degradedReason: typeof marketOpsPayload.degradedReason === "string" ? marketOpsPayload.degradedReason : null,
    },
  }, observedAt);
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
      return sessionCheck(config, env, systemKey, mainStore, "agent:main");
    case "monitor_agent_delivery":
      return sessionCheck(config, env, systemKey, monitorStore, "agent:monitor");
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
      return checkGogHeadlessAuth(config, env);
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
    case "financial_external_services":
      return checkFinancialExternalServices(config, env);
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
