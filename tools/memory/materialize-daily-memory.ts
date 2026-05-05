#!/usr/bin/env npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type SessionMessage = {
  timestampMs: number;
  timeEt: string;
  agentId: string;
  sessionId: string;
  role: "user" | "assistant";
  text: string;
};

type MaterializeOptions = {
  repoRoot: string;
  stateRoot: string;
  dates: string[];
  dryRun?: boolean;
  maxMessagesPerDay?: number;
};

type MaterializeResult = {
  date: string;
  path: string;
  wrote: boolean;
  sessionMessageCount: number;
  artifactCount: number;
};

const DAILY_START = "<!-- cortana:daily-memory:start -->";
const DAILY_END = "<!-- cortana:daily-memory:end -->";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT_CHARS = 260;
const DEFAULT_MAX_MESSAGES = 45;

function usage(): string {
  return [
    "Usage: npx tsx tools/memory/materialize-daily-memory.ts [--date YYYY-MM-DD | --since YYYY-MM-DD --until YYYY-MM-DD | --today] [--dry-run]",
    "",
    "Builds canonical memory/YYYY-MM-DD.md files from live OpenClaw session logs and runtime memory artifacts.",
  ].join("\n");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function formatEtDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function formatEtTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

function parseDate(raw: string): Date {
  if (!DATE_RE.test(raw)) throw new Error(`Invalid date: ${raw}`);
  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (formatEtDate(date) !== raw) throw new Error(`Invalid date: ${raw}`);
  return date;
}

function dateRange(since: string, until: string): string[] {
  const start = parseDate(since);
  const end = parseDate(until);
  if (start.getTime() > end.getTime()) throw new Error("--since must be before --until");

  const dates: string[] = [];
  for (let cursor = new Date(start); cursor.getTime() <= end.getTime(); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    dates.push(formatEtDate(cursor));
  }
  return dates;
}

function yesterdayEt(): string {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - 1);
  return formatEtDate(now);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function parseArgs(argv: string[]): MaterializeOptions {
  const dates: string[] = [];
  let since = "";
  let until = "";
  let repoRoot = process.env.CORTANA_REPO_ROOT || "/Users/hd/Developer/cortana";
  let stateRoot = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw");
  let dryRun = false;
  let maxMessagesPerDay = DEFAULT_MAX_MESSAGES;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--date") {
      const date = argv[++i];
      if (!date) throw new Error("--date requires YYYY-MM-DD");
      dates.push(date);
    } else if (arg === "--since") {
      since = argv[++i] ?? "";
    } else if (arg === "--until") {
      until = argv[++i] ?? "";
    } else if (arg === "--today") {
      dates.push(formatEtDate(new Date()));
    } else if (arg === "--yesterday") {
      dates.push(yesterdayEt());
    } else if (arg === "--repo-root") {
      repoRoot = argv[++i] ?? "";
    } else if (arg === "--state-root") {
      stateRoot = argv[++i] ?? "";
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--max-messages") {
      maxMessagesPerDay = Number(argv[++i] ?? DEFAULT_MAX_MESSAGES);
    } else if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (since || until) {
    if (!since || !until) throw new Error("--since and --until must be used together");
    dates.push(...dateRange(since, until));
  }

  if (dates.length === 0) dates.push(formatEtDate(new Date()));
  const validatedDates = uniqueSorted(dates.map((date) => {
    parseDate(date);
    return date;
  }));

  if (!repoRoot) throw new Error("--repo-root is required");
  if (!stateRoot) throw new Error("--state-root is required");

  return {
    repoRoot,
    stateRoot,
    dates: validatedDates,
    dryRun,
    maxMessagesPerDay: Number.isFinite(maxMessagesPerDay) && maxMessagesPerDay > 0 ? maxMessagesPerDay : DEFAULT_MAX_MESSAGES,
  };
}

function safeReadDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
}

function walkFiles(root: string, predicate: (filePath: string) => boolean): string[] {
  const results: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const item of safeReadDir(current)) {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(item);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(item);
      } else if (stat.isFile() && predicate(item)) {
        results.push(item);
      }
    }
  }

  return results.sort();
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as { type?: string; text?: string };
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("");
}

function sanitizeText(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function redactText(raw: string): string {
  return raw
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[redacted-token]")
    .replace(/\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g, "[redacted-token]")
    .replace(/\b([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,})\b/g, "[redacted-token]");
}

function truncate(raw: string, max = MAX_TEXT_CHARS): string {
  const text = redactText(sanitizeText(raw));
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}...`;
}

function shouldSkipMessage(role: "user" | "assistant", text: string, filePath: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed === "NO_REPLY" || trimmed === "HEARTBEAT_OK") return true;
  if (trimmed.startsWith("[OpenClaw heartbeat poll]")) return true;
  if (role === "user" && trimmed.startsWith("[cron:")) return true;
  if (role === "user" && trimmed.startsWith("[Inter-session message]")) return true;
  if (role === "user" && trimmed.startsWith("OUTPUT LIMIT:")) return true;
  if (role === "user" && trimmed.includes("\nRun exactly:")) return true;
  if (trimmed.startsWith("Conversation info (untrusted metadata):")) return true;
  if (trimmed.includes("You are keeping a dream diary.")) return true;
  if (trimmed.includes("Write a dream diary entry from these memory fragments:")) return true;
  if (filePath.includes("dreaming-narrative-")) return true;
  if (role === "assistant" && trimmed.startsWith("Error: Path escapes sandbox root")) return true;
  if (role === "assistant" && trimmed.includes("proprioception/run_health_checks.ts")) return true;
  if (role === "assistant" && trimmed.includes("Autonomy score:")) return true;
  return false;
}

function inferAgentId(filePath: string, stateRoot: string): string {
  const rel = path.relative(path.join(stateRoot, "agents"), filePath);
  const first = rel.split(path.sep)[0];
  return first || "unknown";
}

function parseSessionMessages(filePath: string, stateRoot: string, wantedDates: Set<string>): SessionMessage[] {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  if (raw.includes("Write a dream diary entry from these memory fragments:")) return [];

  const messages: SessionMessage[] = [];
  const sessionId = path.basename(filePath).replace(/\.jsonl$/, "");
  const agentId = inferAgentId(filePath, stateRoot);

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.type !== "message") continue;
    const role = parsed?.message?.role;
    if (role !== "user" && role !== "assistant") continue;

    const timestampRaw = parsed.timestamp ?? parsed.message?.timestamp;
    const timestampMs = typeof timestampRaw === "number" ? timestampRaw : Date.parse(String(timestampRaw));
    if (!Number.isFinite(timestampMs)) continue;
    const timestamp = new Date(timestampMs);
    const date = formatEtDate(timestamp);
    if (!wantedDates.has(date)) continue;

    const text = extractText(parsed.message?.content ?? parsed.message?.text);
    if (shouldSkipMessage(role, text, filePath)) continue;

    messages.push({
      timestampMs,
      timeEt: formatEtTime(timestamp),
      agentId,
      sessionId,
      role,
      text: truncate(text),
    });
  }

  return messages;
}

function collectSessionMessages(stateRoot: string, dates: string[]): Map<string, SessionMessage[]> {
  const wantedDates = new Set(dates);
  const agentsRoot = path.join(stateRoot, "agents");
  const files = walkFiles(
    agentsRoot,
    (filePath) => filePath.endsWith(".jsonl") && !filePath.endsWith(".trajectory.jsonl")
  );
  const byDate = new Map<string, SessionMessage[]>(dates.map((date) => [date, []]));

  for (const file of files) {
    for (const message of parseSessionMessages(file, stateRoot, wantedDates)) {
      const date = formatEtDate(new Date(message.timestampMs));
      byDate.get(date)?.push(message);
    }
  }

  for (const messages of byDate.values()) {
    messages.sort((a, b) => a.timestampMs - b.timestampMs || a.agentId.localeCompare(b.agentId));
  }
  return byDate;
}

function collectArtifacts(repoRoot: string, date: string): string[] {
  const roots = [
    path.join(repoRoot, "memory", "dreaming"),
    path.join(repoRoot, "memory", "fitness"),
    path.join(repoRoot, "identities"),
  ];
  const suffixes = [
    `${date}.md`,
    `${date}.json`,
    `${date}-tomorrow-session.md`,
  ];
  const artifacts: string[] = [];

  for (const root of roots) {
    for (const filePath of walkFiles(root, (candidate) => suffixes.some((suffix) => candidate.endsWith(suffix)))) {
      artifacts.push(path.relative(repoRoot, filePath));
    }
  }

  return artifacts.sort();
}

function summarizeMessages(messages: SessionMessage[], maxMessages: number): SessionMessage[] {
  const seen = new Set<string>();
  const deduped: SessionMessage[] = [];

  for (const message of messages) {
    const key = `${message.role}:${message.agentId}:${message.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(message);
    if (deduped.length >= maxMessages) break;
  }

  return deduped;
}

function renderDailyBlock(date: string, messages: SessionMessage[], artifacts: string[]): string {
  const generatedAt = new Date().toISOString();
  const lines = [
    DAILY_START,
    `Generated: ${generatedAt}`,
    `Source: live OpenClaw session logs and runtime memory artifacts.`,
    "",
    "## Source Counts",
    `- Session messages: ${messages.length}`,
    `- Runtime artifacts: ${artifacts.length}`,
    "",
    "## Session Continuity",
  ];

  if (messages.length === 0) {
    lines.push("- No eligible user/assistant session messages found for this date.");
  } else {
    for (const message of messages) {
      lines.push(`- ${message.timeEt} ET [${message.agentId}] ${message.role}: ${message.text}`);
    }
  }

  lines.push("", "## Runtime Artifacts");
  if (artifacts.length === 0) {
    lines.push("- No dated runtime memory artifacts found.");
  } else {
    for (const artifact of artifacts) {
      lines.push(`- ${artifact}`);
    }
  }

  lines.push(DAILY_END, "");
  return lines.join("\n");
}

function mergeManagedBlock(existing: string, block: string): string {
  const start = existing.indexOf(DAILY_START);
  const end = existing.indexOf(DAILY_END);
  if (start >= 0 && end > start) {
    const afterEnd = end + DAILY_END.length;
    return `${existing.slice(0, start)}${block.trimEnd()}\n${existing.slice(afterEnd).replace(/^\n+/, "")}`;
  }

  const prefix = existing.trimEnd();
  if (!prefix) return block;
  return `${prefix}\n\n${block}`;
}

export function materializeDailyMemory(options: MaterializeOptions): MaterializeResult[] {
  const memoryDir = path.join(options.repoRoot, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });

  const messagesByDate = collectSessionMessages(options.stateRoot, options.dates);
  const results: MaterializeResult[] = [];

  for (const date of options.dates) {
    const dailyPath = path.join(memoryDir, `${date}.md`);
    const messages = summarizeMessages(messagesByDate.get(date) ?? [], options.maxMessagesPerDay ?? DEFAULT_MAX_MESSAGES);
    const artifacts = collectArtifacts(options.repoRoot, date);
    const block = renderDailyBlock(date, messages, artifacts);
    const existing = fs.existsSync(dailyPath) ? fs.readFileSync(dailyPath, "utf8") : `# Daily Memory - ${date}\n\n`;
    const next = mergeManagedBlock(existing, block);

    if (!options.dryRun) fs.writeFileSync(dailyPath, next, "utf8");
    results.push({
      date,
      path: dailyPath,
      wrote: !options.dryRun,
      sessionMessageCount: messages.length,
      artifactCount: artifacts.length,
    });
  }

  return results;
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    const results = materializeDailyMemory(options);
    for (const result of results) {
      console.log(
        `${options.dryRun ? "would-write" : "wrote"} ${path.relative(options.repoRoot, result.path)} messages=${result.sessionMessageCount} artifacts=${result.artifactCount}`
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(1);
  }
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  void main();
}
