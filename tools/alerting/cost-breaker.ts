#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { withPostgresPath, runPsql } from "../lib/db.js";
import { resolveHomePath } from "../lib/paths.js";
import { readJsonFile } from "../lib/json-file.js";

const env = {
  ...withPostgresPath(process.env),
  PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${withPostgresPath(process.env).PATH ?? ""}`,
};

const DB = process.env.CORTANA_DB ?? "cortana";
const USAGE_CMD = ["npx", "tsx", "/Users/hd/openclaw/skills/telegram-usage/handler.ts", "json"];
const SESSIONS_FILE = process.env.OPENCLAW_SESSIONS_FILE ?? resolveHomePath(".openclaw/agents/main/sessions/sessions.json");
const FLAG_FILE = process.env.COST_ALERT_FLAG_FILE ?? resolveHomePath(".openclaw/cost-alert.flag");
let MONTHLY_BUDGET_USD = Number(process.env.COST_BREAKER_MONTHLY_BUDGET_USD ?? "200");
let RUNAWAY_TOKEN_LIMIT = Number(process.env.RUNAWAY_TOKEN_LIMIT ?? "200000");
const TELEGRAM_GUARD = process.env.TELEGRAM_GUARD ?? "/Users/hd/openclaw/tools/notifications/telegram-delivery-guard.sh";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? "8171372724";

function sqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function logEvent(sev: string, msg: string, meta: Record<string, unknown> = {}) {
  const escMsg = sqlEscape(msg);
  const escMeta = sqlEscape(JSON.stringify(meta));
  runPsql(
    `INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('cost_breaker', 'cost-breaker.sh', '${sev}', '${escMsg}', '${escMeta}');`,
    { db: DB, env, stdio: "ignore" }
  );
}

function run(command: string, args: string[]) {
  return spawnSync(command, args, { encoding: "utf8", env });
}

function sendTelegramAlert(msg: string, severity: "P1" | "P2" = "P1") {
  try {
    fs.accessSync(TELEGRAM_GUARD, fs.constants.X_OK);
    run(TELEGRAM_GUARD, [msg, TELEGRAM_CHAT_ID, "", "cost_breaker", `cost-breaker-${Date.now()}`, severity, "monitor", "System", severity === "P1" ? "now" : "summary", "cron-health"]);
  } catch {
    logEvent("warning", "Telegram guard missing; alert not sent", { guard: TELEGRAM_GUARD });
  }
}

function killRunawaySession(key: string) {
  let killed = false;

  const subagentsKill = run("openclaw", ["subagents", "kill", key]);
  if (subagentsKill.status === 0) {
    killed = true;
  } else {
    const pgrep = run("pgrep", ["-f", key]);
    if (pgrep.status === 0 && pgrep.stdout.trim()) {
      for (const pid of pgrep.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
        run("kill", [pid]);
      }
      killed = true;
    }
  }

  if (killed) {
    logEvent("warning", "Runaway session kill executed", {
      sessionKey: key,
      action: "kill_runaway",
      result: "killed",
    });
  } else {
    logEvent("warning", "Runaway session kill requested but no process found", {
      sessionKey: key,
      action: "kill_runaway",
      result: "not_found",
    });
  }

  console.log(JSON.stringify({ action: "kill_runaway", sessionKey: key, killed }, null, 2));
  process.exit(0);
}

let killSessionKey = "";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--kill-runaway") {
    killSessionKey = argv[i + 1] ?? "";
    if (!killSessionKey) {
      console.error("--kill-runaway requires a sessionKey");
      process.exit(2);
    }
    i += 1;
  } else if (a === "--budget-usd") {
    MONTHLY_BUDGET_USD = Number(argv[i + 1] ?? `${MONTHLY_BUDGET_USD}`);
    i += 1;
  } else if (a === "--runaway-token-limit") {
    RUNAWAY_TOKEN_LIMIT = Number(argv[i + 1] ?? `${RUNAWAY_TOKEN_LIMIT}`);
    i += 1;
  } else if (a === "-h" || a === "--help") {
    console.log(`Usage: ${path.basename(process.argv[1])} [options]\n\nOptions:\n  --kill-runaway <sessionKey>      Attempt to kill runaway session process by key\n  --budget-usd <amount>            Monthly budget in USD (default: ${MONTHLY_BUDGET_USD})\n  --runaway-token-limit <tokens>   Runaway token limit (default: ${RUNAWAY_TOKEN_LIMIT})\n  -h, --help                       Show help`);
    process.exit(0);
  } else {
    console.error(`Unknown option: ${a}`);
    process.exit(2);
  }
}

if (killSessionKey) killRunawaySession(killSessionKey);

const usageExec = run(USAGE_CMD[0], USAGE_CMD.slice(1));
const usageRaw = `${usageExec.stdout ?? ""}${usageExec.stderr ?? ""}`;
const start = usageRaw.indexOf("{");
const end = usageRaw.lastIndexOf("}");
const usageJson = start >= 0 && end > start ? usageRaw.slice(start, end + 1) : "{}";

let usageParsed: any = {};
try {
  usageParsed = JSON.parse(usageJson);
} catch {
  usageParsed = {};
}

const inputTokens = Number(usageParsed?.totalTokens?.input ?? 0);
const outputTokens = Number(usageParsed?.totalTokens?.output ?? 0);
const model = String(usageParsed?.model ?? "unknown");
const provider = String(usageParsed?.provider ?? "unknown");
const totalTokens = inputTokens + outputTokens;

let inRate = 0.01;
let outRate = 0.03;
const modelLc = model.toLowerCase();
if (modelLc.includes("haiku")) {
  inRate = 0.0008;
  outRate = 0.004;
} else if (modelLc.includes("sonnet")) {
  inRate = 0.003;
  outRate = 0.015;
} else if (modelLc.includes("opus")) {
  inRate = 0.015;
  outRate = 0.075;
} else if (modelLc.includes("gpt-4.1-mini")) {
  inRate = 0.0006;
  outRate = 0.0024;
} else if (modelLc.includes("gpt-4.1") || modelLc.includes("gpt-4o")) {
  inRate = 0.005;
  outRate = 0.015;
} else if (modelLc.includes("gpt-5") || modelLc.includes("codex")) {
  inRate = 0.01;
  outRate = 0.03;
}

const currentSpend = Number(((inputTokens / 1000) * inRate + (outputTokens / 1000) * outRate).toFixed(6));
const now = new Date();
const nowDay = now.getDate();
const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
const burnRate = Number((currentSpend / (nowDay > 0 ? nowDay : 1)).toFixed(6));
const projectedMonthly = Number((burnRate * daysInMonth).toFixed(6));
const pctBudget = Number((MONTHLY_BUDGET_USD <= 0 ? 0 : (currentSpend / MONTHLY_BUDGET_USD) * 100).toFixed(2));

let runawaySessions: Array<{ sessionKey: string; totalTokens: number; updatedAt: string | null }> = [];
const sessions = readJsonFile<Record<string, any>>(SESSIONS_FILE);
if (sessions && typeof sessions === "object") {
  runawaySessions = Object.entries(sessions)
    .filter(([k, v]) => /subagent|agent:main:subagent/i.test(k) && Number(v?.totalTokens ?? (Number(v?.inputTokens ?? 0) + Number(v?.outputTokens ?? 0))) > RUNAWAY_TOKEN_LIMIT)
    .map(([k, v]) => ({
      sessionKey: k,
      totalTokens: Number(v?.totalTokens ?? (Number(v?.inputTokens ?? 0) + Number(v?.outputTokens ?? 0))),
      updatedAt: v?.updatedAt ?? null,
    }));
}

const warnPreMidmonth = pctBudget >= 50 && nowDay < 15;
const alert75Anytime = pctBudget >= 75;
const critical = alert75Anytime || runawaySessions.length > 0;

const breaches: Array<Record<string, unknown>> = [];
if (warnPreMidmonth) breaches.push({ id: "warn_50_pre_midmonth", severity: "warning" });
if (alert75Anytime) breaches.push({ id: "alert_75_anytime", severity: "critical" });
if (runawaySessions.length > 0) breaches.push({ id: "runaway_subagent_tokens", severity: "critical", limitTokens: RUNAWAY_TOKEN_LIMIT });

if (critical) {
  fs.mkdirSync(path.dirname(FLAG_FILE), { recursive: true });
  fs.writeFileSync(
    FLAG_FILE,
    `${JSON.stringify(
      {
        triggeredAt: new Date().toISOString(),
        pctBudgetUsed: pctBudget,
        breaches,
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  logEvent("error", "Cost breaker critical threshold breached", {
    model,
    provider,
    pctBudgetUsed: pctBudget,
    currentSpend,
    projectedMonthly,
    runawaySessions,
    breaches,
  });

  sendTelegramAlert(
    `🚨 Cost breaker tripped: ${pctBudget}% of monthly budget used ($${currentSpend.toFixed(6)} so far, projected $${projectedMonthly.toFixed(6)}). Breaches: ${breaches.map((b) => b.id).join(", ")}.`
  );
} else {
  try {
    fs.rmSync(FLAG_FILE, { force: true });
  } catch {
    // ignore
  }
}

if (warnPreMidmonth) {
  logEvent("warning", "Cost breaker warning threshold breached (50% before mid-month)", {
    pctBudgetUsed: pctBudget,
    dayOfMonth: nowDay,
  });
  sendTelegramAlert(`⚠️ Cost breaker warning: ${pctBudget}% of budget used before mid-month (projected $${projectedMonthly.toFixed(2)}).`, "P2");
}
if (alert75Anytime) {
  logEvent("error", "Cost breaker alert threshold breached (75% anytime)", { pctBudgetUsed: pctBudget });
}

const summary = {
  timestamp: new Date().toISOString(),
  model,
  provider,
  monthlyBudgetUsd: MONTHLY_BUDGET_USD,
  usage: {
    inputTokens,
    outputTokens,
    totalTokens,
  },
  spend: {
    currentUsd: currentSpend,
    burnRateUsdPerDay: burnRate,
    projectedMonthlyUsd: projectedMonthly,
    pctOfBudget: pctBudget,
  },
  period: {
    dayOfMonth: nowDay,
    daysInMonth,
  },
  thresholds: {
    warning50BeforeMidMonth: {
      enabled: true,
      breached: breaches.some((b) => b.id === "warn_50_pre_midmonth"),
    },
    alert75Anytime: {
      enabled: true,
      breached: breaches.some((b) => b.id === "alert_75_anytime"),
    },
    runawaySessionTokens: {
      limit: RUNAWAY_TOKEN_LIMIT,
      breached: breaches.some((b) => b.id === "runaway_subagent_tokens"),
    },
  },
  runawaySessions,
  breachedThresholds: breaches,
  criticalBreach: critical,
  flagFile: critical ? FLAG_FILE : null,
};

console.log(JSON.stringify(summary, null, 2));
