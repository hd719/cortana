import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ACCOUNT = process.env.GOG_ACCOUNT ?? "hameldesai3@gmail.com";
const REPO_ROOT = "/Users/hd/Developer/cortana";
const GOG_HELPER = `${REPO_ROOT}/tools/gog/gog-with-env.ts`;
const SENT_PATH =
  process.env.FLIGHT_PRICE_WATCH_SENT_PATH ??
  "/Users/hd/.openclaw/memory/google-flight-price-watch-sent.json";

const SEARCH_QUERY =
  process.env.FLIGHT_PRICE_WATCH_QUERY ??
  [
    "newer_than:30d",
    "(",
    "from:google.com",
    "OR from:googletravel-noreply@google.com",
    "OR from:travel-noreply@google.com",
    ")",
    "(",
    '"Google Flights"',
    "OR",
    '"flight price"',
    "OR",
    '"tracked flight"',
    "OR",
    '"Marrakesh"',
    "OR",
    '"Marrakech"',
    "OR",
    '"RAK"',
    ")",
  ].join(" ");

type SearchThread = {
  id: string;
  date?: string;
  from?: string;
  subject?: string;
  labels?: string[];
  messageCount?: number;
};

type SearchOutput = {
  threads?: SearchThread[];
};

type GmailMessage = {
  id?: string;
  snippet?: string;
  internalDate?: string;
  payload?: {
    body?: { data?: string };
    headers?: Array<{ name: string; value: string }>;
    parts?: GmailMessage["payload"][];
  };
};

type ThreadOutput = {
  thread?: {
    id?: string;
    messages?: GmailMessage[];
  };
};

type SentState = {
  version: 1;
  sentMessageIds: string[];
};

function runGog(args: string[]): string {
  const result = spawnSync(
    "npx",
    ["tsx", GOG_HELPER, "--account", ACCOUNT, ...args, "--json", "--no-input"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown gog failure").trim();
    throw new Error(detail);
  }

  return result.stdout;
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function messageBody(payload: GmailMessage["payload"]): string {
  if (!payload) return "";

  const chunks: string[] = [];
  if (payload.body?.data) chunks.push(decodeBase64Url(payload.body.data));
  for (const part of payload.parts ?? []) chunks.push(messageBody(part));
  return chunks.join("\n");
}

function header(message: GmailMessage, name: string): string {
  const value = message.payload?.headers?.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
  )?.value;
  return value ?? "";
}

function readSentState(): SentState {
  if (!existsSync(SENT_PATH)) return { version: 1, sentMessageIds: [] };
  const parsed = JSON.parse(readFileSync(SENT_PATH, "utf8")) as SentState;
  return {
    version: 1,
    sentMessageIds: Array.isArray(parsed.sentMessageIds) ? parsed.sentMessageIds : [],
  };
}

function writeSentState(state: SentState): void {
  mkdirSync(dirname(SENT_PATH), { recursive: true });
  const uniqueIds = Array.from(new Set(state.sentMessageIds)).slice(-500);
  writeFileSync(
    SENT_PATH,
    `${JSON.stringify(
      {
        version: 1,
        sentMessageIds: uniqueIds,
      },
      null,
      2,
    )}\n`,
  );
}

function extractPrices(text: string): number[] {
  const prices = [...text.matchAll(/\$\s*([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{3,})/g)]
    .map((match) => Number(match[1].replace(/,/g, "")))
    .filter((price) => Number.isFinite(price) && price >= 1000 && price <= 50000);
  return Array.from(new Set(prices)).sort((a, b) => a - b);
}

export function extractRoute(text: string): string {
  const normalized = text.replace(/\s+/g, " ");
  const from = normalized.match(/\b(Newark|New York|JFK|EWR)\b/i)?.[1];
  const to = normalized.match(/\b(Marrakesh|Marrakech|RAK)\b/i)?.[1];
  if (!from && !to) return "NYC -> Marrakesh";
  return `${from ?? "NYC"} -> ${to ?? "Marrakesh"}`;
}

function verdict(price: number | null): string {
  if (price == null) return "Inspect manually; no clean total price found.";
  if (price <= 5500) return "BOOK FAST if routing is sane.";
  if (price <= 6500) return "Strong deal zone.";
  if (price <= 7500) return "Acceptable if the itinerary is good.";
  return "Watch only; still expensive.";
}

export function isFlightAlert(text: string, from: string, subject: string): boolean {
  const haystack = `${from}\n${subject}\n${text}`;
  const googleish = /google|google flights|google travel/i.test(haystack);
  const flightish = /flight|tracked price|price alert|track prices|travel/i.test(haystack);
  const marrakeshish = /marrakesh|marrakech|\bRAK\b/i.test(haystack);
  return googleish && flightish && marrakeshish;
}

function summarize(threadId: string, message: GmailMessage, body: string): string | null {
  const from = header(message, "From");
  const subject = header(message, "Subject");
  const combined = `${subject}\n${message.snippet ?? ""}\n${body}`;

  if (!isFlightAlert(combined, from, subject)) return null;

  const prices = extractPrices(combined);
  const lowest = prices[0] ?? null;
  const route = extractRoute(combined);
  const priceText = lowest == null ? "unknown" : `$${lowest.toLocaleString("en-US")}`;
  const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${threadId}`;

  return [
    "✈️ Marrakesh Flights - Google price alert",
    `Route: ${route}`,
    `Lowest seen: ${priceText} total for 2 business seats`,
    `Verdict: ${verdict(lowest)}`,
    `Open: ${gmailUrl}`,
  ].join("\n");
}

async function main(): Promise<void> {
  let search: SearchOutput;
  try {
    search = JSON.parse(runGog(["gmail", "search", SEARCH_QUERY, "--max", "10"])) as SearchOutput;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`✈️ Morocco Flights - watcher failed\nGmail search failed: ${detail.slice(0, 300)}`);
    return;
  }

  const sent = readSentState();

  if ((search.threads ?? []).length === 0) {
    console.log("NO_REPLY");
    return;
  }

  const sentIds = new Set(sent.sentMessageIds);
  const alerts: string[] = [];
  const newlySeen: string[] = [];

  for (const candidate of search.threads ?? []) {
    if (!candidate.id) continue;

    let thread: ThreadOutput;
    try {
      thread = JSON.parse(runGog(["gmail", "thread", "get", candidate.id])) as ThreadOutput;
    } catch {
      continue;
    }

    for (const message of thread.thread?.messages ?? []) {
      const messageId = message.id ?? candidate.id;
      if (sentIds.has(messageId)) continue;

      const body = messageBody(message.payload);
      const alert = summarize(candidate.id, message, body);
      if (alert) alerts.push(alert);
      newlySeen.push(messageId);
    }
  }

  if (newlySeen.length > 0) {
    writeSentState({ version: 1, sentMessageIds: [...sent.sentMessageIds, ...newlySeen] });
  }

  if (alerts.length === 0) {
    console.log("NO_REPLY");
    return;
  }

  console.log(alerts[0].split("\n").slice(0, 5).join("\n"));
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && process.argv[1] === thisFile) {
  main().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`✈️ Morocco Flights - watcher failed\n${detail.slice(0, 300)}`);
  });
}
