#!/usr/bin/env npx tsx

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TELEGRAM_TARGET = "8171372724";
const DEFAULT_TIMEOUT_MS = 180_000;
const TELEGRAM_MAX_MESSAGE_LEN = 3500;

const NOISY_KEYS = new Set([
  "metadata",
  "toolTrace",
  "toolTraces",
  "tool_trace",
  "trace",
  "traces",
  "systemPromptReport",
  "system_prompt_report",
  "usage",
  "tokenUsage",
  "tokens",
]);

type SpecialistTask = {
  sessionKey: string;
  agentId: string;
  prompt: string;
};

type SpecialistResult = {
  sessionKey: string;
  ok: boolean;
  text: string;
};

const SPECIALIST_TASKS: SpecialistTask[] = [
  {
    sessionKey: "agent:researcher:main",
    agentId: "researcher",
    prompt:
      "Gather today's top 3-5 news headlines (world + tech). Return concise bullet summary.",
  },
  {
    sessionKey: "agent:oracle:main",
    agentId: "oracle",
    prompt:
      "Pre-market snapshot: futures, key indices, overnight movers for held positions. Return concise summary.",
  },
  {
    sessionKey: "agent:monitor:main",
    agentId: "monitor",
    prompt:
      "Overnight system health: gateway status, cron failures, alerts. Return concise status.",
  },
];

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function runCommand(cmd: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await withTimeout(
    execFileAsync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    }),
    timeoutMs,
    `${cmd} ${args.join(" ")}`,
  );
  return (stdout ?? "").trim();
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function cleanText(input: string): string {
  return input
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") {
    const cleaned = cleanText(value);
    return cleaned ? [cleaned] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectText(item));
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const obj = value as Record<string, unknown>;
  const preferredKeys = ["reply", "response", "output", "output_text", "text", "content", "message"];
  for (const key of preferredKeys) {
    if (key in obj && !NOISY_KEYS.has(key)) {
      const nested = collectText(obj[key]);
      if (nested.length > 0) return nested;
    }
  }

  return [];
}

function pruneAgentNoise(text: string): string {
  const lines = text
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(line))
    .filter((line) => !/^(ok|completed|openai-codex)$/i.test(line))
    .filter((line) => !/^gpt-[a-z0-9._-]+$/i.test(line));

  return lines.join("\n").trim();
}

function extractAgentText(raw: string): string {
  const parsed = safeJsonParse(raw) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") return pruneAgentNoise(cleanText(raw)) || "No response text returned.";

  const resultObj = parsed.result as Record<string, unknown> | undefined;
  const candidates: unknown[] = [
    parsed.reply,
    parsed.response,
    parsed.output,
    parsed.output_text,
    parsed.text,
    parsed.content,
    parsed.message,
    parsed.payloads,
    resultObj?.reply,
    resultObj?.response,
    resultObj?.output,
    resultObj?.output_text,
    resultObj?.text,
    resultObj?.content,
    resultObj?.message,
    resultObj?.payloads,
  ];

  for (const candidate of candidates) {
    const collected = collectText(candidate).join("\n").trim();
    const pruned = pruneAgentNoise(collected);
    if (pruned) return pruned;
  }

  return "No response text returned.";
}

function splitForTelegram(messageText: string): string[] {
  if (messageText.length <= TELEGRAM_MAX_MESSAGE_LEN) return [messageText];

  const maxChunkLen = TELEGRAM_MAX_MESSAGE_LEN - 32;
  const lines = messageText.split(/\n/);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  for (const line of lines) {
    if (line.length > maxChunkLen) {
      pushCurrent();
      for (let i = 0; i < line.length; i += maxChunkLen) {
        chunks.push(line.slice(i, i + maxChunkLen));
      }
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxChunkLen) {
      pushCurrent();
      current = line;
    } else {
      current = candidate;
    }
  }

  pushCurrent();
  return chunks;
}

async function sessionsSend(task: SpecialistTask): Promise<SpecialistResult> {
  try {
    const raw = await runCommand("openclaw", [
      "agent",
      "--agent",
      task.agentId,
      "--message",
      task.prompt,
      "--json",
      "--timeout",
      "240",
    ]);

    return {
      sessionKey: task.sessionKey,
      ok: true,
      text: extractAgentText(raw),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      sessionKey: task.sessionKey,
      ok: false,
      text: `Unavailable (${msg})`,
    };
  }
}

async function fetchWeather(): Promise<string> {
  try {
    return await runCommand("curl", ["-s", "wttr.in/Warren+NJ?format=3"], 20_000);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `Weather unavailable (${msg})`;
  }
}

async function fetchCalendar(): Promise<string> {
  try {
    const out = await runCommand(
      "gog",
      ["cal", "list", "Clawdbot-Calendar", "--from", "today", "--to", "tomorrow", "--plain"],
      45_000,
    );
    return out || "No events found.";
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `Calendar unavailable (${msg})`;
  }
}

function buildBrief(parts: {
  weather: string;
  calendar: string;
  specialists: SpecialistResult[];
}): string {
  const timestamp = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const specialistMap = new Map(parts.specialists.map((s) => [s.sessionKey, s]));
  const researcher = specialistMap.get("agent:researcher:main")?.text ?? "Unavailable";
  const oracle = specialistMap.get("agent:oracle:main")?.text ?? "Unavailable";
  const monitor = specialistMap.get("agent:monitor:main")?.text ?? "Unavailable";

  return [
    `☀️ Morning Brief — ${timestamp} ET`,
    "",
    `🌤️ Weather: ${parts.weather}`,
    "",
    "🗓️ Calendar (today → tomorrow):",
    parts.calendar,
    "",
    "📰 News (Researcher):",
    researcher,
    "",
    "📈 Pre-market (Oracle):",
    oracle,
    "",
    "🛡️ System Health (Monitor):",
    monitor,
  ].join("\n");
}

async function sendTelegram(messageText: string): Promise<void> {
  const chunks = splitForTelegram(messageText);
  for (let i = 0; i < chunks.length; i += 1) {
    const label = chunks.length > 1 ? `Part ${i + 1}/${chunks.length}\n` : "";
    const outbound = `${label}${chunks[i]}`;
    const safeOutbound = outbound.slice(0, TELEGRAM_MAX_MESSAGE_LEN);

    await runCommand("openclaw", [
      "message",
      "send",
      "--channel",
      "telegram",
      "--target",
      TELEGRAM_TARGET,
      "--message",
      safeOutbound,
      "--json",
    ]);
  }
}

async function main(): Promise<void> {
  const [specialists, weather, calendar] = await Promise.all([
    Promise.all(SPECIALIST_TASKS.map((task) => sessionsSend(task))),
    fetchWeather(),
    fetchCalendar(),
  ]);

  const brief = buildBrief({ specialists, weather, calendar });
  await sendTelegram(brief);
  process.stdout.write(`${brief}\n`);
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  const failMsg = `☀️ Morning Brief - ERROR\n${msg}`;

  sendTelegram(failMsg)
    .catch(() => {
      // swallow secondary failure to preserve original non-zero exit.
    })
    .finally(() => {
      process.stderr.write(`${failMsg}\n`);
      process.exit(1);
    });
});
