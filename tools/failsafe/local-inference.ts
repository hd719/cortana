#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { PSQL_BIN } from "../lib/paths.js";

const DEFAULT_MODEL = process.env.FAILSAFE_MODEL ?? "phi3:mini";
const DEFAULT_TIMEOUT = Number.parseFloat(process.env.FAILSAFE_TIMEOUT_SEC ?? "6");
const PSQL_PATH = process.env.PSQL_PATH ?? PSQL_BIN;
const DB_NAME = process.env.CORTANA_DB ?? "cortana";

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function utcNowIso(): string {
  return new Date().toISOString();
}

function run(cmd: string[], timeout?: number): RunResult {
  const proc = spawnSync(cmd[0], cmd.slice(1), {
    encoding: "utf8",
    timeout: timeout ? Math.round(timeout * 1000) : undefined,
  });
  return {
    code: proc.status ?? 1,
    stdout: (proc.stdout || "").trim(),
    stderr: (proc.stderr || "").trim(),
  };
}

function sqlEscape(value: string): string {
  return value.replace(/'/g, "''");
}

function logEvent(
  severity: string,
  message: string,
  metadata: Record<string, unknown> = {},
  eventType = "failsafe",
  source = "local-inference",
): void {
  const metaJson = JSON.stringify(metadata);
  const query =
    "INSERT INTO cortana_events (event_type, source, severity, message, metadata) " +
    `VALUES ('${sqlEscape(eventType)}','${sqlEscape(source)}','${sqlEscape(severity)}','${sqlEscape(message)}','${sqlEscape(metaJson)}'::jsonb);`;

  const proc = spawnSync(PSQL_PATH, [DB_NAME, "-c", query], { encoding: "utf8" });
  if (proc.status !== 0) {
    const msg = (proc.stderr || proc.stdout || "").trim();
    if (msg) console.error(`[warn] failed to write cortana_events: ${msg}`);
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutSec: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkOpenAI(timeoutSec: number): Promise<[boolean, string]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [false, "OPENAI_API_KEY missing"];

  try {
    const res = await fetchWithTimeout(
      "https://api.openai.com/v1/models",
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
      timeoutSec,
    );
    const code = res.status;
    if (code >= 200 && code < 500) return [true, `reachable (${code})`];
    return [false, `http ${code}`];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [false, `${err?.constructor?.name ?? "Error"}: ${msg}`];
  }
}

async function checkAnthropic(timeoutSec: number): Promise<[boolean, string]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [false, "ANTHROPIC_API_KEY missing"];

  const payload = {
    model: "claude-3-5-haiku-latest",
    max_tokens: 1,
    messages: [{ role: "user", content: "ping" }],
  };

  try {
    const res = await fetchWithTimeout(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      timeoutSec,
    );
    const code = res.status;
    if (code >= 200 && code < 500) return [true, `reachable (${code})`];
    return [false, `http ${code}`];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [false, `${err?.constructor?.name ?? "Error"}: ${msg}`];
  }
}

async function detectOutage(timeoutSec: number): Promise<[boolean, Record<string, string>]> {
  const [openaiOk, openaiMsg] = await checkOpenAI(timeoutSec);
  const [anthropicOk, anthropicMsg] = await checkAnthropic(timeoutSec);
  const details = {
    openai: openaiMsg,
    anthropic: anthropicMsg,
    checked_at: utcNowIso(),
  };
  return [!openaiOk && !anthropicOk, details];
}

function ensureOllamaModel(model: string): void {
  const list = run(["ollama", "list"], 15);
  if (list.code !== 0) throw new Error(`ollama not ready: ${list.stderr || list.stdout}`);
  if (list.stdout.includes(model)) return;

  const pulled = run(["ollama", "pull", model], 600);
  if (pulled.code !== 0) throw new Error(`failed to pull model ${model}: ${pulled.stderr || pulled.stdout}`);
}

function localInfer(model: string, prompt: string): string {
  ensureOllamaModel(model);
  const res = run(["ollama", "run", model, prompt], 180);
  if (res.code !== 0) throw new Error(`ollama run failed: ${res.stderr || res.stdout}`);
  return res.stdout.trim();
}

function getReadyTasks(limit: number): Array<Record<string, any>> {
  const query = `
        SELECT id, title, priority, due_at, auto_executable, status
        FROM cortana_tasks
        WHERE status = 'ready'
          AND auto_executable = TRUE
          AND (depends_on IS NULL OR NOT EXISTS (
              SELECT 1 FROM cortana_tasks t2
              WHERE t2.id = ANY(cortana_tasks.depends_on)
                AND t2.status != 'completed'
          ))
        ORDER BY priority ASC, created_at ASC
        LIMIT ${Number(limit)};
        `;

  const proc = spawnSync(PSQL_PATH, [DB_NAME, "-At", "-F", "|", "-c", query.trim()], { encoding: "utf8" });
  if (proc.status !== 0) {
    const msg = (proc.stderr || proc.stdout || "").trim();
    throw new Error(`task query failed: ${msg}`);
  }

  const out = (proc.stdout || "").trim();
  if (!out) return [];

  const tasks: Array<Record<string, any>> = [];
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split("|");
    if (parts.length < 6) continue;
    tasks.push({
      id: Number.parseInt(parts[0], 10),
      title: parts[1],
      priority: /^\d+$/.test(parts[2]) ? Number.parseInt(parts[2], 10) : null,
      due_at: parts[3] || null,
      auto_executable: parts[4] === "t",
      status: parts[5],
    });
  }
  return tasks;
}

function buildTaskQueuePrompt(tasks: Array<Record<string, any>>): string {
  if (!tasks.length) {
    return "No ready auto-executable tasks exist. Provide a short operational status line and one recommendation.";
  }
  const taskLines = tasks
    .map((t) => `- #${t.id} P${t.priority}: ${t.title} (due: ${t.due_at ?? "n/a"})`)
    .join("\n");
  return (
    "You are a failsafe operations assistant. " +
    "Given ready tasks, return:\n" +
    "1) Top 3 tasks to execute now (with one-line rationale each)\n" +
    "2) One sequencing recommendation\n" +
    "3) One risk to watch\n\n" +
    `Tasks:\n${taskLines}`
  );
}

function runFailsafe(mode: string, prompt: string | null, model: string, limit: number): Record<string, any> {
  const payload: Record<string, any> = {
    mode,
    model,
    timestamp: utcNowIso(),
  };

  let userPrompt = "";
  if (mode === "task_queue") {
    const tasks = getReadyTasks(limit);
    payload.task_count = tasks.length;
    userPrompt = buildTaskQueuePrompt(tasks);
  } else if (mode === "qa" || mode === "alert") {
    if (!prompt) throw new Error(`--prompt is required for mode=${mode}`);
    if (mode === "alert") {
      userPrompt =
        "Write a concise operator alert (<= 5 lines), include impact + immediate next action.\n\n" +
        `Context: ${prompt}`;
    } else {
      userPrompt = prompt;
    }
  } else {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  const output = localInfer(model, userPrompt);
  payload.output = output;
  return payload;
}

function parseArgs(argv: string[]) {
  const args = {
    mode: "" as "task_queue" | "alert" | "qa" | "",
    prompt: null as string | null,
    model: DEFAULT_MODEL,
    limit: 10,
    timeout: DEFAULT_TIMEOUT,
    forceLocal: false,
  };

  if (argv.length) {
    args.mode = argv[0] as any;
  }

  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--prompt") {
      args.prompt = argv[++i] ?? null;
    } else if (a === "--model") {
      args.model = argv[++i] ?? args.model;
    } else if (a === "--limit") {
      args.limit = Number.parseInt(argv[++i] ?? "10", 10);
    } else if (a === "--timeout") {
      args.timeout = Number.parseFloat(argv[++i] ?? String(DEFAULT_TIMEOUT));
    } else if (a === "--force-local") {
      args.forceLocal = true;
    }
  }

  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode || !["task_queue", "alert", "qa"].includes(args.mode)) {
    console.error("mode must be one of: task_queue, alert, qa");
    return 2;
  }

  let outage = false;
  let outageDetails: Record<string, string> = {};

  if (!args.forceLocal) {
    [outage, outageDetails] = await detectOutage(args.timeout);
  } else {
    outage = true;
    outageDetails = { forced: "true", checked_at: utcNowIso() };
  }

  if (outage) {
    const isTest = args.forceLocal;
    logEvent(
      isTest ? "info" : "warning",
      isTest ? "Failover test: local inference validated" : "API outage detected; switching to local inference",
      {
        mode: args.mode,
        model: args.model,
        details: outageDetails,
      },
      isTest ? "failover_test" : "failover",
      "local-inference",
    );

    try {
      const result = runFailsafe(args.mode, args.prompt, args.model, args.limit);
      console.log(JSON.stringify({ path: "local", outage: true, ...result }, null, 2));
      return 0;
    } catch (err) {
      logEvent(
        "error",
        "Local inference fallback failed",
        {
          mode: args.mode,
          model: args.model,
          error: err instanceof Error ? err.message : String(err),
        },
        "failover_error",
        "local-inference",
      );
      console.error(`[error] local fallback failed: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
  }

  console.log(
    JSON.stringify(
      {
        path: "remote",
        outage: false,
        message: "Remote APIs are reachable; no fallback needed",
        checks: outageDetails,
      },
      null,
      2,
    ),
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
