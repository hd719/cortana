#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { readJsonFile } from "../lib/json-file.js";
import { resolveHomePath } from "../lib/paths.js";

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
  /api key/,
  /authentication/,
  /auth failure/,
  /quota exceeded/,
  /insufficient_quota/,
  /billing/,
  /model not allowed/,
];
const CRITICAL_JOB_NAMES = [
  "☀️ Morning brief (Hamel)",
  "📈 Stock Market Brief (daily)",
  "🏋️ Fitness Morning Brief (Hamel)",
  "📅 Calendar reminders → Telegram (ALL calendars)",
  "🌙 Weekend Pre-Bedtime (9:30pm Fri/Sat)",
];
const STANDARD_MODEL = "openai-codex/gpt-5.3-codex";

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

async function probeOpenAIAuth(): Promise<{ ok: boolean; detail: string }> {
  const apiKey = readOpenAIKey();
  if (!apiKey) return { ok: false, detail: "OpenAI API key missing from config/env" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(OPENAI_MODELS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, detail: `models probe ok (${res.status})` };
    const body = (await res.text()).slice(0, 200);
    return { ok: false, detail: `models probe failed (${res.status}): ${body}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function authFailureText(job: Job): string | null {
  const state = isRecord(job.state) ? job.state : {};
  const fields = [state.lastError, state.lastErrorMessage, state.lastRunError, state.lastOutput, state.lastStatusDetail]
    .map((v) => String(v ?? ""))
    .filter(Boolean);
  const joined = fields.join(" | ");
  return AUTH_PATTERNS.some((rx) => rx.test(joined.toLowerCase())) ? joined : null;
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
  const modelDrift = jobs.filter((job) => String((job.payload as JsonMap | undefined)?.model ?? "") !== STANDARD_MODEL);
  const probe = await probeOpenAIAuth();
  if (probe.ok && modelDrift.length === 0) {
    console.log(JSON.stringify({ ok: true, checked: jobs.length, probe: probe.detail }));
    return 0;
  }

  const driftText = modelDrift.length
    ? `model drift on: ${modelDrift.map((job) => `${job.name}→${String((job.payload as JsonMap | undefined)?.model ?? "")}`).join(", ")}`
    : "model routing aligned";
  sendGuard(
    `🚨 OpenAI cron auth preflight failed\nProbe: ${probe.detail}\nCritical jobs: ${jobs.length}\nRouting: ${driftText}`,
    "openai_cron_auth_preflight",
    `openai-cron-auth-preflight-${new Date().toISOString().slice(0, 13)}`
  );
  console.log(JSON.stringify({ ok: false, probe: probe.detail, drift: modelDrift.map((j) => j.name) }));
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

  const retried = affected.map(({ job, authText }) => {
    const retry = retryJob(String(job.id ?? ""));
    return { name: job.name, id: job.id, authText, retry };
  });

  const lines = retried.map((row) => `${row.name}: ${row.retry.ok ? "retry-ok" : "retry-failed"} — ${row.retry.detail}`);
  sendGuard(
    `🚨 OpenAI auth failures hit critical cron jobs\n${lines.join("\n")}`,
    "openai_cron_auth_failure",
    `openai-cron-auth-sweep-${new Date().toISOString().slice(0, 13)}`
  );
  console.log(JSON.stringify({ ok: false, affected: retried.length, retried }, null, 2));
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
