#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { readJsonFile } from "../lib/json-file.js";
import { resolveHomePath } from "../lib/paths.js";
import {
  loadRoutePolicy as loadProviderRoutePolicy,
  loadState as loadProviderHealthState,
  providerAvailability,
  recordRequest as recordProviderHealthRequest,
  routeFor as routeProviderHealth,
  saveState as saveProviderHealthState,
} from "../guardrails/provider-health.js";

const JOBS_FILE = resolveHomePath(".openclaw", "cron", "jobs.json");
const CONFIG_FILE = path.join(process.cwd(), "config", "openclaw.json");
const TELEGRAM_GUARD = path.join(process.cwd(), "tools", "notifications", "telegram-delivery-guard.sh");
const TARGET = process.env.TELEGRAM_CHAT_ID ?? "8171372724";
const OPENAI_MODELS_URL = process.env.OPENAI_MODELS_URL ?? "https://api.openai.com/v1/models";
const AUTH_PATTERNS = [
  /401/,
  /403/,
  /unauthoriz/,
  /invalid[_ -]?api[_ -]?key/,
  /incorrect[_ -]?api[_ -]?key/,
  /authentication/,
  /auth failure/,
  /expired token/,
  /token expired/,
  /invalid[_ -]?token/,
  /reauth/,
  /login required/,
  /session expired/,
];
const TRANSIENT_PATTERNS = [
  /429/,
  /quota exceeded/,
  /insufficient_quota/,
  /billing/,
  /rate limit/,
  /too many requests/,
  /overloaded?/,
  /temporar(y|ily) unavailable/,
  /timeout/,
  /timed out/,
  /deadline exceeded/,
  /econnreset/,
  /enotfound/,
  /network/,
  /fetch failed/,
];
const CRITICAL_JOB_NAMES = [
  "☀️ Morning brief (Hamel)",
  "📈 Stock Market Brief (daily)",
  "🏋️ Fitness Morning Brief (Hamel)",
  "📅 Calendar reminders → Telegram (ALL calendars)",
  "🌙 Weekend Pre-Bedtime (9:30pm Fri/Sat)",
];
const STANDARD_MODEL = "openai-codex/gpt-5.3-codex";
const OPENAI_PROVIDER = "codex";
const AUTH_PROBE_ATTEMPTS = Math.max(1, Number(process.env.OPENAI_AUTH_PROBE_ATTEMPTS ?? "2"));
const AUTH_PROBE_RETRY_MS = Math.max(0, Number(process.env.OPENAI_AUTH_PROBE_RETRY_MS ?? "1000"));

type JsonMap = Record<string, unknown>;

type Job = JsonMap & {
  id?: string;
  name?: string;
  enabled?: boolean;
  payload?: JsonMap;
  state?: JsonMap;
};

function isRecord(v: unknown): v is JsonMap {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function loadJobs(): Job[] {
  const data = readJsonFile<JsonMap>(JOBS_FILE);
  return data && Array.isArray(data.jobs) ? (data.jobs as Job[]) : [];
}

function criticalJobs(jobs: Job[]): Job[] {
  return jobs.filter((job) => job.enabled !== false && CRITICAL_JOB_NAMES.includes(String(job.name ?? "")));
}

function readOpenAIKey(): string {
  const cfg = readJsonFile<JsonMap>(CONFIG_FILE);
  const provider = isRecord(cfg?.models) && isRecord((cfg.models as JsonMap).providers)
    ? ((cfg.models as JsonMap).providers as JsonMap).openai
    : null;
  const apiKey = isRecord(provider) ? String(provider.apiKey ?? "") : "";
  if (apiKey && apiKey !== "__OPENCLAW_REDACTED__") return apiKey;
  return String(process.env.OPENAI_API_KEY ?? "");
}

function configuredOpenAIModels(): Set<string> {
  const cfg = readJsonFile<JsonMap>(CONFIG_FILE);
  const models = isRecord(cfg?.models) && isRecord((cfg.models as JsonMap).available)
    ? ((cfg.models as JsonMap).available as JsonMap)
    : {};
  const allowed = Object.keys(models).filter((model) => model.startsWith("openai-codex/"));
  allowed.push(STANDARD_MODEL);
  return new Set(allowed);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyProbeFailure(detail: string): "auth" | "transient" | "unknown" {
  const text = detail.toLowerCase();
  if (AUTH_PATTERNS.some((rx) => rx.test(text))) return "auth";
  if (TRANSIENT_PATTERNS.some((rx) => rx.test(text))) return "transient";
  return "unknown";
}

function providerStatusCode(kind: "auth" | "transient" | "unknown", detail: string): number {
  const text = detail.toLowerCase();
  if (kind === "auth") return 401;
  if (/429|quota exceeded|insufficient_quota|rate limit|too many requests/.test(text)) return 429;
  if (/timeout|timed out|deadline exceeded|abort/.test(text)) return 504;
  if (kind === "transient") return 503;
  return 520;
}

function checkProviderCircuit() {
  const policy = loadProviderRoutePolicy();
  const state = loadProviderHealthState(policy);
  const availability = providerAvailability(state, OPENAI_PROVIDER);
  const route = routeProviderHealth(OPENAI_PROVIDER, 503, state, policy);
  return { availability, route };
}

function recordProviderProbe(statusCode: number) {
  const policy = loadProviderRoutePolicy();
  const state = loadProviderHealthState(policy);
  const provider = recordProviderHealthRequest(state, OPENAI_PROVIDER, statusCode);
  const route = routeProviderHealth(OPENAI_PROVIDER, statusCode, state, policy);
  saveProviderHealthState(state);
  return { provider, route };
}

async function probeOpenAIAuth(): Promise<{ ok: boolean; detail: string; kind: "auth" | "transient" | "unknown" }> {
  const apiKey = readOpenAIKey();
  if (!apiKey) return { ok: false, detail: "OpenAI API key missing from config/env", kind: "auth" };

  let lastFailure = { ok: false as const, detail: "OpenAI probe did not run", kind: "unknown" as const };
  for (let attempt = 1; attempt <= AUTH_PROBE_ATTEMPTS; attempt += 1) {
    const gate = checkProviderCircuit();
    if (!gate.availability.attempt_allowed) {
      const fallback = gate.route.fallback_provider ? `; fallback=${gate.route.fallback_provider}` : "";
      const reason = gate.route.circuit_reason ? `; reason=${gate.route.circuit_reason}` : "";
      return {
        ok: false,
        detail: `OpenAI provider circuit ${gate.availability.circuit}; probe skipped${fallback}${reason}`,
        kind: "transient",
      };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(OPENAI_MODELS_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (res.ok) {
        recordProviderProbe(res.status);
        return { ok: true, detail: `models probe ok (${res.status})`, kind: "auth" };
      }
      const body = (await res.text()).slice(0, 200);
      const detail = `models probe failed (${res.status}): ${body}`;
      const kind = classifyProbeFailure(detail);
      const breaker = recordProviderProbe(res.status);
      const suffix = breaker.provider.circuit === "open" ? `; circuit=open reason=${breaker.provider.last_trip_reason ?? "unknown"}` : "";
      lastFailure = { ok: false, detail: `${detail}${suffix} [attempt ${attempt}/${AUTH_PROBE_ATTEMPTS}]`, kind };
      if (kind !== "transient" || breaker.provider.circuit === "open" || attempt === AUTH_PROBE_ATTEMPTS) return lastFailure;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const kind = classifyProbeFailure(detail);
      const breaker = recordProviderProbe(providerStatusCode(kind, detail));
      const suffix = breaker.provider.circuit === "open" ? `; circuit=open reason=${breaker.provider.last_trip_reason ?? "unknown"}` : "";
      lastFailure = { ok: false, detail: `${detail}${suffix} [attempt ${attempt}/${AUTH_PROBE_ATTEMPTS}]`, kind };
      if (kind !== "transient" || breaker.provider.circuit === "open" || attempt === AUTH_PROBE_ATTEMPTS) return lastFailure;
    } finally {
      clearTimeout(timeout);
    }
    await sleep(AUTH_PROBE_RETRY_MS);
  }

  return lastFailure;
}

function authFailureText(job: Job): string | null {
  const state = isRecord(job.state) ? job.state : {};
  const fields = [state.lastError, state.lastErrorMessage, state.lastRunError, state.lastOutput, state.lastStatusDetail]
    .map((v) => String(v ?? ""))
    .filter(Boolean);
  const joined = fields.join(" | ");
  const lowered = joined.toLowerCase();
  if (!joined) return null;
  if (TRANSIENT_PATTERNS.some((rx) => rx.test(lowered))) return null;
  return AUTH_PATTERNS.some((rx) => rx.test(lowered)) ? joined : null;
}

function sendGuard(message: string, alertType: string, dedupeKey: string): void {
  spawnSync(TELEGRAM_GUARD, [message, TARGET, "", alertType, dedupeKey, "P1", "monitor", "System", "now", "cron-maintenance"], {
    encoding: "utf8",
  });
}

function retryJob(jobId: string): { ok: boolean; detail: string } {
  const proc = spawnSync("openclaw", ["cron", "run", jobId], { encoding: "utf8", timeout: 240000 });
  const detail = `${(proc.stdout ?? "")}${(proc.stderr ?? "")}`.trim().slice(0, 500);
  return { ok: proc.status === 0, detail: detail || `exit=${proc.status ?? "null"}` };
}

async function runPreflight(): Promise<number> {
  const jobs = criticalJobs(loadJobs());
  const allowedOpenAIModels = configuredOpenAIModels();
  const modelDrift = jobs.filter((job) => {
    const model = String((job.payload as JsonMap | undefined)?.model ?? "");
    return !allowedOpenAIModels.has(model);
  });
  const probe = await probeOpenAIAuth();
  if (probe.ok && modelDrift.length === 0) {
    console.log(JSON.stringify({ ok: true, checked: jobs.length, probe: probe.detail }));
    return 0;
  }

  const driftText = modelDrift.length
    ? `non-openai or unconfigured routing on: ${modelDrift.map((job) => `${job.name}→${String((job.payload as JsonMap | undefined)?.model ?? "")}`).join(", ")}`
    : "model routing aligned";
  sendGuard(
    `🚨 OpenAI cron auth preflight failed\nProbe: ${probe.detail}\nProbe kind: ${probe.kind}\nCritical jobs: ${jobs.length}\nRouting: ${driftText}`,
    "openai_cron_auth_preflight",
    `openai-cron-auth-preflight-${new Date().toISOString().slice(0, 13)}`
  );
  console.log(JSON.stringify({ ok: false, probe: probe.detail, probeKind: probe.kind, drift: modelDrift.map((j) => j.name) }));
  return 1;
}

async function runSweep(): Promise<number> {
  const jobs = criticalJobs(loadJobs());
  const affected = jobs
    .map((job) => ({ job, authText: authFailureText(job) }))
    .filter((row) => row.authText);

  if (affected.length === 0) {
    console.log(JSON.stringify({ ok: true, affected: 0 }));
    return 0;
  }

  const probe = await probeOpenAIAuth();
  if (!probe.ok) {
    const lines = affected.map((row) => `${row.job.name}: auth-still-broken — ${String(row.authText).slice(0, 200)}`);
    sendGuard(
      `🚨 OpenAI auth failures hit critical cron jobs\nProbe: ${probe.detail}\n${lines.join("\n")}`,
      "openai_cron_auth_failure",
      `openai-cron-auth-sweep-${new Date().toISOString().slice(0, 13)}`
    );
    console.log(JSON.stringify({ ok: false, affected: affected.length, probe: probe.detail, retried: 0 }, null, 2));
    return 1;
  }

  const retried = affected.map(({ job, authText }) => {
    const retry = retryJob(String(job.id ?? ""));
    return { name: job.name, id: job.id, authText, retry };
  });

  const lines = retried.map((row) => `${row.name}: ${row.retry.ok ? "retry-ok" : "retry-failed"} — ${row.retry.detail}`);
  sendGuard(
    `🚨 OpenAI auth failures hit critical cron jobs\nProbe: ${probe.detail}\n${lines.join("\n")}`,
    "openai_cron_auth_failure",
    `openai-cron-auth-sweep-${new Date().toISOString().slice(0, 13)}`
  );
  console.log(JSON.stringify({ ok: false, affected: retried.length, probe: probe.detail, retried }, null, 2));
  return 1;
}

async function main(): Promise<number> {
  const cmd = process.argv[2] ?? "preflight";
  if (cmd === "preflight") return runPreflight();
  if (cmd === "sweep") return runSweep();
  console.error("usage: openai-cron-auth-guard.ts <preflight|sweep>");
  return 2;
}

main().then((code) => process.exit(code));
