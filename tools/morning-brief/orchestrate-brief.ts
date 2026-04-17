#!/usr/bin/env npx tsx

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TELEGRAM_TARGET = "8171372724";
const DEFAULT_TIMEOUT_MS = 180_000;
const TELEGRAM_MAX_MESSAGE_LEN = 3500;
const ET_TIME_ZONE = "America/New_York";
const CALENDAR_HELPER = "/Users/hd/Developer/cortana/tools/gog/calendar-events-json.ts";
const REMINDER_LIST = "Cortana";

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

type GogCalendarEvent = {
  id?: string;
  summary?: string;
  status?: string;
  start?: {
    date?: string;
    dateTime?: string;
  };
};

type ReminderItem = {
  title?: string;
  isCompleted?: boolean;
  listName?: string;
};

type BriefParts = {
  weather: string;
  schedule: string[];
  reminders: string[];
  specialists: SpecialistResult[];
};

type WttrWeatherPayload = {
  current_condition?: Array<{
    temp_F?: string;
    FeelsLikeF?: string;
    weatherDesc?: Array<{ value?: string }>;
    windspeedMiles?: string;
  }>;
  weather?: Array<{
    maxtempF?: string;
    mintempF?: string;
    hourly?: Array<{ chanceofrain?: string }>;
  }>;
};

type OpenMeteoWeatherPayload = {
  current_weather?: {
    temperature?: number;
    windspeed?: number;
    weathercode?: number;
  };
  daily?: {
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
  };
};

const SPECIALIST_TASKS: SpecialistTask[] = [
  {
    sessionKey: "agent:researcher:main",
    agentId: "researcher",
    prompt:
      "Return exactly 2 short bullets for Hamel's morning brief: one high-signal US/world item and one tech/cyber item. No intro.",
  },
  {
    sessionKey: "agent:oracle:main",
    agentId: "oracle",
    prompt:
      "Return 1-2 short bullets for a morning market snapshot: market status plus one notable risk or focus. No intro.",
  },
];

const WTTR_URL = "https://wttr.in/Warren+NJ?format=j1";
const OPEN_METEO_URL =
  "https://api.open-meteo.com/v1/forecast" +
  "?latitude=40.63&longitude=-74.49" +
  "&current_weather=true" +
  "&temperature_unit=fahrenheit" +
  "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
  "&timezone=America/New_York&forecast_days=1";

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

function formatWttrWeather(parsed: WttrWeatherPayload | null): string | null {
  const current = parsed?.current_condition?.[0];
  const today = parsed?.weather?.[0];
  if (!current || !today) return null;

  const condition = (current.weatherDesc?.[0]?.value ?? "Weather").trim();
  const temp = current.temp_F ?? "?";
  const feels = current.FeelsLikeF ?? temp;
  const high = today.maxtempF ?? "?";
  const low = today.mintempF ?? "?";
  const rain =
    today.hourly?.reduce((max, hour) => {
      const chance = Number(hour?.chanceofrain ?? 0);
      return Number.isFinite(chance) ? Math.max(max, chance) : max;
    }, 0) ?? 0;
  const wind = current.windspeedMiles ?? "?";

  return `${condition}, ${temp}F (feels ${feels}F), high ${high}/low ${low}, rain ${rain}%, wind ${wind} mph`;
}

function describeWeatherCode(code: number | undefined): string {
  if (code === undefined || !Number.isFinite(code)) return "Weather";
  if (code === 0) return "Clear";
  if (code >= 1 && code <= 3) return "Partly cloudy";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 67) return "Rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code >= 85 && code <= 86) return "Snow showers";
  if (code >= 95 && code <= 99) return "Thunderstorm";
  return "Weather";
}

function formatOpenMeteoWeather(parsed: OpenMeteoWeatherPayload | null): string | null {
  const current = parsed?.current_weather;
  const daily = parsed?.daily;
  if (!current || !daily) return null;

  const temp = Number(current.temperature);
  const high = Number(daily.temperature_2m_max?.[0]);
  const low = Number(daily.temperature_2m_min?.[0]);
  const rain = Number(daily.precipitation_probability_max?.[0] ?? 0);
  const wind = Number(current.windspeed);

  if (![temp, high, low, wind].every((value) => Number.isFinite(value))) return null;

  const condition = describeWeatherCode(current.weathercode);
  return `${condition}, ${Math.round(temp)}F (feels ${Math.round(temp)}F), high ${Math.round(high)}/low ${Math.round(low)}, rain ${Math.round(rain)}%, wind ${Math.round(wind)} mph`;
}

export async function fetchWeatherWithRunCommand(
  run: (cmd: string, args: string[], timeoutMs?: number) => Promise<string>,
): Promise<string> {
  const errors: string[] = [];

  try {
    const raw = await run("curl", ["-fsSL", WTTR_URL], 20_000);
    const formatted = formatWttrWeather(safeJsonParse(raw) as WttrWeatherPayload | null);
    if (formatted) return formatted;
    errors.push("wttr.in returned invalid weather data");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const raw = await run("curl", ["-fsSL", OPEN_METEO_URL], 20_000);
    const formatted = formatOpenMeteoWeather(safeJsonParse(raw) as OpenMeteoWeatherPayload | null);
    if (formatted) return formatted;
    errors.push("Open-Meteo returned invalid weather data");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return `Weather unavailable (${errors.join("; ")})`;
}

async function fetchWeather(): Promise<string> {
  return fetchWeatherWithRunCommand(runCommand);
}

function formatEventLabel(event: GogCalendarEvent): string | null {
  const summary = (event.summary ?? "Untitled").trim();
  if (!summary) return null;

  const dateTime = event.start?.dateTime;
  const allDayDate = event.start?.date;
  if (dateTime) {
    const dt = new Date(dateTime);
    if (Number.isNaN(dt.getTime())) return summary;
    const label = new Intl.DateTimeFormat("en-US", {
      timeZone: ET_TIME_ZONE,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(dt);
    return `${label} - ${summary}`;
  }

  if (allDayDate) return `All day - ${summary}`;
  return summary;
}

function eventSortKey(event: GogCalendarEvent): number {
  const dateTime = event.start?.dateTime;
  if (dateTime) {
    const ts = Date.parse(dateTime);
    if (Number.isFinite(ts)) return ts;
  }
  const allDayDate = event.start?.date;
  if (allDayDate) {
    const ts = Date.parse(allDayDate);
    if (Number.isFinite(ts)) return ts;
  }
  return Number.MAX_SAFE_INTEGER;
}

export function parseCalendarEvents(rawEvents: GogCalendarEvent[]): string[] {
  const seen = new Set<string>();
  return rawEvents
    .filter((event) => event && event.status !== "cancelled")
    .sort((a, b) => eventSortKey(a) - eventSortKey(b))
    .map((event) => ({
      key: `${event.start?.dateTime ?? event.start?.date ?? "na"}|${(event.summary ?? "").trim()}`,
      label: formatEventLabel(event),
    }))
    .filter((entry) => Boolean(entry.label))
    .filter((entry) => {
      if (seen.has(entry.key)) return false;
      seen.add(entry.key);
      return true;
    })
    .map((entry) => entry.label as string)
    .slice(0, 6);
}

async function fetchCalendarFrom(calendarId: string): Promise<GogCalendarEvent[]> {
  const raw = await runCommand(
    "npx",
    [
      "tsx",
      CALENDAR_HELPER,
      "--account",
      "hameldesai3@gmail.com",
      "cal",
      "list",
      calendarId,
      "--from",
      "today",
      "--to",
      "today",
      "--json",
    ],
    45_000,
  );

  const parsed = safeJsonParse(raw) as { events?: GogCalendarEvent[] } | null;
  return Array.isArray(parsed?.events) ? parsed.events : [];
}

async function fetchSchedule(): Promise<string[]> {
  try {
    const [primary, clawdbot] = await Promise.all([
      fetchCalendarFrom("primary"),
      fetchCalendarFrom("Clawdbot-Calendar"),
    ]);
    const merged = parseCalendarEvents([...primary, ...clawdbot]);
    return merged.length ? merged : ["No calendar blocks today."];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [`Calendar unavailable (${msg})`];
  }
}

async function fetchReminders(): Promise<string[]> {
  try {
    const raw = await runCommand("remindctl", ["all", "--json"], 30_000);
    const parsed = safeJsonParse(raw);
    if (!Array.isArray(parsed)) return ["Reminders unavailable (invalid output)."];

    const open = (parsed as ReminderItem[])
      .filter((item) => item && item.isCompleted === false)
      .filter((item) => (item.listName ?? "") === REMINDER_LIST)
      .map((item) => (item.title ?? "").trim())
      .filter(Boolean)
      .slice(0, 5);

    return open.length ? open : ["No open Cortana reminders."];
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return [`Reminders unavailable (${msg})`];
  }
}

function normalizeBullets(input: string, fallback: string, maxItems: number): string[] {
  const lines = cleanText(input)
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, maxItems);
  return lines.length ? lines : [fallback];
}

export function buildBrief(parts: BriefParts): string {
  const specialistMap = new Map(parts.specialists.map((s) => [s.sessionKey, s]));
  const news = normalizeBullets(
    specialistMap.get("agent:researcher:main")?.text ?? "",
    "News unavailable.",
    2,
  );
  const markets = normalizeBullets(
    specialistMap.get("agent:oracle:main")?.text ?? "",
    "Market snapshot unavailable.",
    2,
  );

  const renderSection = (title: string, items: string[]) => [
    `${title}:`,
    ...items.map((line) => `- ${line}`),
  ];

  const lines = [
    "☀️ Brief - Morning Brief",
    "",
    ...renderSection("Schedule", parts.schedule),
    "",
    ...renderSection("Apple Reminders", parts.reminders),
    "",
    ...renderSection("Weather", [parts.weather]),
    "",
    ...renderSection("News", news),
    "",
    ...renderSection("Markets", markets),
  ];

  return lines.join("\n");
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

export async function runMorningBrief(options: { dryRun?: boolean } = {}): Promise<string> {
  const [specialists, weather, schedule, reminders] = await Promise.all([
    Promise.all(SPECIALIST_TASKS.map((task) => sessionsSend(task))),
    fetchWeather(),
    fetchSchedule(),
    fetchReminders(),
  ]);

  const brief = buildBrief({ specialists, weather, schedule, reminders });
  if (!options.dryRun) {
    await sendTelegram(brief);
  }
  return brief;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const brief = await runMorningBrief({ dryRun });
  process.stdout.write(dryRun ? `${brief}\n` : "Morning brief sent.\n");
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error);
  const failMsg = `☀️ Morning Brief - ERROR\n${msg}`;

  if (process.argv.includes("--dry-run")) {
    process.stderr.write(`${failMsg}\n`);
    process.exit(1);
  }

  sendTelegram(failMsg)
    .catch(() => {
      // swallow secondary failure to preserve original non-zero exit.
    })
    .finally(() => {
      process.stderr.write(`${failMsg}\n`);
      process.exit(1);
    });
});
