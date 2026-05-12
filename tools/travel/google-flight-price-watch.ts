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
const CDP_TARGETS_URL = process.env.FLIGHT_PRICE_WATCH_CDP_TARGETS_URL ?? "http://127.0.0.1:18792/json";
const DEFAULT_BROWSER_BUDGET_MS = 30_000;
const PAGE_READY_POLL_MS = 250;
const TARGET_READY_POLL_MS = 500;

export type GoogleFlightSearch = {
  route: string;
  url: string;
  urlNeedle: string;
};

const GOOGLE_FLIGHT_SEARCHES: GoogleFlightSearch[] = [
  {
    route: "New York -> Rabat | Aug 5-17",
    url: "https://www.google.com/travel/flights?q=Flights%20from%20JFK%20to%20RBA%20August%205%202026%20to%20August%2017%202026%20business%20class%202%20adults",
    urlNeedle: "Flights%20from%20JFK%20to%20RBA%20August%205%202026%20to%20August%2017%202026%20business%20class%202%20adults",
  },
  {
    route: "Newark -> Rabat | Aug 5-17",
    url: "https://www.google.com/travel/flights?q=Flights%20from%20EWR%20to%20RBA%20August%205%202026%20to%20August%2017%202026%20business%20class%202%20adults",
    urlNeedle: "Flights%20from%20EWR%20to%20RBA%20August%205%202026%20to%20August%2017%202026%20business%20class%202%20adults",
  },
  {
    route: "New York -> Rabat | Aug 7-17",
    url: "https://www.google.com/travel/flights?q=Flights%20from%20JFK%20to%20RBA%20August%207%202026%20to%20August%2017%202026%20business%20class%202%20adults",
    urlNeedle: "Flights%20from%20JFK%20to%20RBA%20August%207%202026%20to%20August%2017%202026%20business%20class%202%20adults",
  },
  {
    route: "Newark -> Rabat | Aug 7-17",
    url: "https://www.google.com/travel/flights?q=Flights%20from%20EWR%20to%20RBA%20August%207%202026%20to%20August%2017%202026%20business%20class%202%20adults",
    urlNeedle: "Flights%20from%20EWR%20to%20RBA%20August%207%202026%20to%20August%2017%202026%20business%20class%202%20adults",
  },
] as const;

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
    '"Rabat"',
    "OR",
    '"RBA"',
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
  lastSnapshotDate?: string;
  lastSnapshotFailureDate?: string;
  lastSnapshotPrices?: Record<string, number>;
};

type FlightSnapshot = {
  route: string;
  account: string;
  trackLabel: string;
  trackingEnabled: boolean;
  priceInsight: string;
  lowestPrice: number | null;
  prices: number[];
  bestFlight: string;
  url: string;
};

type CdpTarget = {
  id?: string;
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type FlightPageValue = {
  route?: string;
  account?: string;
  trackLabel?: string;
  checked?: string | null;
  priceInsight?: string;
  prices?: number[];
  bestFlight?: string;
  url?: string;
};

type CdpValue = FlightPageValue | string | boolean | null;

type CdpCommandResult = {
  result?: {
    value?: CdpValue;
  };
};

type CdpResponseMessage = {
  id?: number;
  error?: string | { code?: number; message?: string; data?: string };
  result?: CdpCommandResult;
};

type CdpClient = {
  send(method: string, params?: Record<string, JsonValue>): Promise<CdpCommandResult>;
  close(): void;
};

export type RunDeadline = {
  remainingMs(): number;
  expired(): boolean;
  budgetMs(maxMs: number, minimumMs?: number): number;
};

export function createRunDeadline(timeoutMs: number, now: () => number = Date.now): RunDeadline {
  const startedAtMs = now();
  return {
    remainingMs() {
      return Math.max(0, startedAtMs + timeoutMs - now());
    },
    expired() {
      return this.remainingMs() <= 0;
    },
    budgetMs(maxMs: number, minimumMs = 0) {
      const remaining = this.remainingMs();
      if (remaining < minimumMs) return 0;
      return Math.max(0, Math.min(maxMs, remaining));
    },
  };
}

function configuredBrowserDeadline(): RunDeadline {
  const raw = Number(process.env.FLIGHT_PRICE_WATCH_BROWSER_BUDGET_MS ?? DEFAULT_BROWSER_BUDGET_MS);
  const timeoutMs = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BROWSER_BUDGET_MS;
  return createRunDeadline(timeoutMs);
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

function todayEt(): string {
  return process.env.FLIGHT_PRICE_WATCH_TODAY ?? formatEtDate(new Date());
}

export function matchesGoogleFlightSearchTarget(target: CdpTarget, search: GoogleFlightSearch): boolean {
  return (
    target.type === "page" &&
    typeof target.url === "string" &&
    target.url.includes("google.com/travel/flights") &&
    target.url.includes(search.urlNeedle)
  );
}

export function missingGoogleFlightSearches(
  targets: CdpTarget[],
  searches: GoogleFlightSearch[] = GOOGLE_FLIGHT_SEARCHES,
): GoogleFlightSearch[] {
  return searches.filter(
    (search) =>
      !targets.some((target) => matchesGoogleFlightSearchTarget(target, search)),
  );
}

export function buildCdpNewTabUrl(targetsUrl: string, searchUrl: string): string {
  const base = targetsUrl.replace(/\/json\/?$/, "/json/new");
  return `${base}?${encodeURIComponent(searchUrl)}`;
}

export function extractFlightNumbersFromGoogleFlightUrl(url: string): string[] {
  let encoded: string | null = null;
  try {
    encoded = new URL(url).searchParams.get("tfs");
  } catch {
    encoded = null;
  }
  if (!encoded) return [];

  const decoded = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const flightNumbers: string[] = [];
  for (let index = 0; index < decoded.length - 7; index += 1) {
    if (decoded[index] !== 42 || decoded[index + 1] !== 2) continue;
    const carrier = decoded.subarray(index + 2, index + 4).toString("ascii");
    const numberLengthIndex = index + 5;
    const numberStart = index + 6;
    const numberLength = decoded[numberLengthIndex];
    const numberEnd = numberStart + numberLength;
    if (decoded[index + 4] !== 50 || numberLength < 1 || numberLength > 4 || numberEnd > decoded.length) continue;

    const number = decoded.subarray(numberStart, numberEnd).toString("ascii");
    if (/^[A-Z]{2}$/.test(carrier) && /^\d{1,4}$/.test(number)) {
      flightNumbers.push(`${carrier}${number}`);
    }
  }

  return Array.from(new Set(flightNumbers));
}

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
    const detail = (result.stderr || result.stdout || "gog failure without output").trim();
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
    lastSnapshotDate: typeof parsed.lastSnapshotDate === "string" ? parsed.lastSnapshotDate : undefined,
    lastSnapshotFailureDate:
      typeof parsed.lastSnapshotFailureDate === "string" ? parsed.lastSnapshotFailureDate : undefined,
    lastSnapshotPrices:
      parsed.lastSnapshotPrices && typeof parsed.lastSnapshotPrices === "object"
        ? parsed.lastSnapshotPrices
        : undefined,
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
        lastSnapshotDate: state.lastSnapshotDate,
        lastSnapshotFailureDate: state.lastSnapshotFailureDate,
        lastSnapshotPrices: state.lastSnapshotPrices,
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

export function extractRoundTripPrices(text: string): number[] {
  const prices = [...text.matchAll(/\$\s*([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{3,}) round trip/g)]
    .map((match) => Number(match[1].replace(/,/g, "")))
    .filter((price) => Number.isFinite(price) && price >= 1000 && price <= 50000);
  return Array.from(new Set(prices)).sort((a, b) => a - b);
}

function cleanAirlineText(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1, $2")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractBestFlightDetails(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const priceIndex = lines.findIndex((line, index) => /^\$[0-9,]+$/.test(line) && /round trip/i.test(lines[index + 1] ?? ""));
  if (priceIndex < 0) return "";

  const routeIndex = lines
    .slice(Math.max(0, priceIndex - 10), priceIndex)
    .findIndex((line) => /\b[A-Z]{3}\s*[–-]\s*[A-Z]{3}\b/.test(line));
  if (routeIndex < 0) return "";

  const windowStart = Math.max(0, priceIndex - 10);
  const absoluteRouteIndex = windowStart + routeIndex;
  const route = lines[absoluteRouteIndex]?.replace(/\s+/g, "");
  const duration = lines[absoluteRouteIndex - 1] ?? "";
  const airlines = cleanAirlineText(lines[absoluteRouteIndex - 2] ?? "");
  const arrival = lines[absoluteRouteIndex - 3] ?? "";
  const departure = lines[absoluteRouteIndex - 5] ?? "";
  const stops = lines[absoluteRouteIndex + 1] ?? "";
  const connection = lines[absoluteRouteIndex + 2] ?? "";
  const flightNumbers = Array.from(
    new Set(lines.slice(windowStart, priceIndex).join(" ").match(/\b[A-Z]{2}\s?\d{2,4}\b/g) ?? []),
  );

  const parts = [
    departure && arrival ? `${departure}-${arrival}` : "",
    airlines,
    route,
    duration,
    stops,
    /\b[A-Z]{3}\b/.test(connection) ? `via ${connection}` : "",
    flightNumbers.length > 0 ? `flight ${flightNumbers.join("/")}` : "flight # not shown",
  ].filter(Boolean);

  return parts.join(", ");
}

function formatPrice(price: number | null): string {
  return price == null ? "not found" : `$${price.toLocaleString("en-US")}`;
}

function compactRoute(route: string): string {
  return route
    .replace("New York -> Rabat | Aug 5-17", "JFK Aug5")
    .replace("Newark -> Rabat | Aug 5-17", "EWR Aug5")
    .replace("New York -> Rabat | Aug 7-17", "JFK Aug7")
    .replace("Newark -> Rabat | Aug 7-17", "EWR Aug7");
}

function compactDuration(value: string): string {
  return value.replace(/\b(\d+)\s*hr\s*(\d+)\s*min\b/i, "$1h$2m");
}

function compactConnection(value: string): string {
  const airport = value.match(/\b[A-Z]{3}\b/)?.[0];
  return airport ? `via ${airport}` : "";
}

function compactPriceInsight(value: string): string {
  return value.replace(/^Prices are currently\s+/i, "").trim();
}

function compactBestFlightDetails(value: string): string {
  if (!value) return "";
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  const routeIndex = parts.findIndex((part) => /\b[A-Z]{3}\s*[–-]\s*[A-Z]{3}\b/.test(part));
  if (routeIndex < 0) return value;

  const time = parts[0] ?? "";
  const airlines = parts.slice(1, routeIndex).join("/").replace(/\s*\/\s*/g, "/");
  const duration = compactDuration(parts[routeIndex + 1] ?? "");
  const stops = parts[routeIndex + 2] ?? "";
  const connection = compactConnection(parts[routeIndex + 3] ?? "");
  const flight = parts.find((part) => /^flight\b/i.test(part))?.replace(/^flight\s+/i, "") ?? "";

  return [
    time,
    airlines,
    duration,
    [stops, connection].filter(Boolean).join(" "),
    flight,
  ].filter(Boolean).join(", ");
}

export function extractRoute(text: string): string {
  const normalized = text.replace(/\s+/g, " ");
  const from = normalized.match(/\b(Newark|New York|JFK|EWR)\b/i)?.[1];
  const to = normalized.match(/\b(Rabat|RBA)\b/i)?.[1];
  if (!from && !to) return "NYC -> Rabat";
  return `${from ?? "NYC"} -> ${to ?? "Rabat"}`;
}

function verdict(price: number | null): string {
  if (price == null) return "Inspect manually; no clean total price found.";
  if (price <= 5500) return "BOOK FAST if routing is sane.";
  if (price <= 6500) return "Strong deal zone.";
  if (price <= 7500) return "Acceptable if the itinerary is good.";
  return "Watch only; still expensive.";
}

function materialDrop(route: string, price: number | null, state: SentState): boolean {
  if (price == null) return false;
  const previous = state.lastSnapshotPrices?.[route];
  if (previous == null) return true;
  return typeof previous === "number" && previous - price >= 300;
}

export function shouldSendSnapshot(state: SentState, date: string, snapshots: FlightSnapshot[]): boolean {
  if (snapshots.length === 0) return false;
  if (state.lastSnapshotDate !== date) return true;
  return snapshots.some((snapshot) => materialDrop(snapshot.route, snapshot.lowestPrice, state));
}

export function buildSnapshotMessage(snapshots: FlightSnapshot[]): string {
  const ordered = snapshots;
  const lowest = ordered
    .map((snapshot) => snapshot.lowestPrice)
    .filter((price): price is number => typeof price === "number")
    .sort((a, b) => a - b)[0] ?? null;
  const lines = [
    "✈️ Rabat Flights - price snapshot",
    "Google has not emailed yet; live browser check is working.",
    ...ordered.map((snapshot) => {
      const insight = compactPriceInsight(snapshot.priceInsight);
      const insightText = insight ? `, ${insight}` : "";
      const tracking = snapshot.trackingEnabled ? "tracking on" : "tracking off";
      const bestFlight = compactBestFlightDetails(snapshot.bestFlight);
      const bestFlightText = bestFlight ? `; top ${bestFlight}` : "";
      return `${compactRoute(snapshot.route)}: ${formatPrice(snapshot.lowestPrice)} for 2 biz${insightText}, ${tracking}${bestFlightText}`;
    }),
    `Verdict: ${verdict(lowest)}`,
  ];
  return lines.join("\n");
}

function snapshotPrices(snapshots: FlightSnapshot[]): Record<string, number> {
  return Object.fromEntries(
    snapshots
      .filter((snapshot) => typeof snapshot.lowestPrice === "number")
      .map((snapshot) => [snapshot.route, snapshot.lowestPrice as number]),
  );
}

export function isFlightAlert(text: string, from: string, subject: string): boolean {
  const haystack = `${from}\n${subject}\n${text}`;
  const googleish = /google|google flights|google travel/i.test(haystack);
  const flightish = /flight|tracked price|price alert|track prices|travel/i.test(haystack);
  const rabatish = /rabat|\bRBA\b/i.test(haystack);
  return googleish && flightish && rabatish;
}

function summarize(threadId: string, message: GmailMessage, body: string): string | null {
  const from = header(message, "From");
  const subject = header(message, "Subject");
  const combined = `${subject}\n${message.snippet ?? ""}\n${body}`;

  if (!isFlightAlert(combined, from, subject)) return null;

  const prices = extractPrices(combined);
  const lowest = prices[0] ?? null;
  const route = extractRoute(combined);
  const priceText = lowest == null ? "not found" : `$${lowest.toLocaleString("en-US")}`;
  const gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${threadId}`;

  return [
    "✈️ Rabat Flights - Google price alert",
    `Route: ${route}`,
    `Lowest seen: ${priceText} total for 2 business seats`,
    `Verdict: ${verdict(lowest)}`,
    `Open: ${gmailUrl}`,
  ].join("\n");
}

async function connectCdp(wsUrl: string): Promise<CdpClient> {
  if (typeof WebSocket !== "function") {
    throw new Error("Node WebSocket global is unavailable");
  }

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("CDP websocket connection failed"));
  });

  let id = 0;
  const pending = new Map<number, { resolve(value: CdpCommandResult): void; reject(error: Error): void }>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as CdpResponseMessage;
    if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
    else waiter?.resolve(message.result ?? {});
  };

  return {
    send(method: string, params: Record<string, JsonValue> = {}) {
      return new Promise((resolve, reject) => {
        const messageId = ++id;
        pending.set(messageId, { resolve, reject });
        ws.send(JSON.stringify({ id: messageId, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

async function openCdpTab(search: GoogleFlightSearch): Promise<CdpTarget | null> {
  const url = buildCdpNewTabUrl(CDP_TARGETS_URL, search.url);
  let response = await fetch(url, { method: "PUT" });
  if (!response.ok && response.status === 405) {
    response = await fetch(url);
  }
  if (!response.ok) {
    throw new Error(`failed to open ${search.route}: HTTP ${response.status}`);
  }
  return (await response.json().catch(() => null)) as CdpTarget | null;
}

function isFlightPageValue(value: CdpValue | undefined): value is FlightPageValue {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractSnapshotFromPage(value: CdpValue | undefined, search?: GoogleFlightSearch): FlightSnapshot | null {
  const record = isFlightPageValue(value) ? value : {};
  const route = search?.route ?? record.route ?? "";
  const prices = Array.isArray(record.prices) ? record.prices.filter((price): price is number => typeof price === "number") : [];
  if (!route || prices.length === 0) return null;
  return {
    route,
    account: typeof record.account === "string" ? record.account : "",
    trackLabel: typeof record.trackLabel === "string" ? record.trackLabel : "",
    trackingEnabled: record.checked === "true",
    priceInsight: typeof record.priceInsight === "string" ? record.priceInsight : "",
    lowestPrice: prices[0] ?? null,
    prices,
    bestFlight: typeof record.bestFlight === "string" ? record.bestFlight : "",
    url: typeof record.url === "string" ? record.url : "",
  };
}

function flightSearchPages(
  targets: CdpTarget[],
  search: GoogleFlightSearch,
): Array<CdpTarget & { webSocketDebuggerUrl: string }> {
  return selectGoogleFlightSearchPages(targets, search);
}

function isGenericGoogleFlightsPage(target: CdpTarget): boolean {
  const title = target.title ?? "";
  return /Find Cheap Flights Worldwide|Book Your Ticket|^Google Flights$/i.test(title);
}

function targetQuality(target: CdpTarget): number {
  if (!target.webSocketDebuggerUrl) return 0;
  if (isGenericGoogleFlightsPage(target)) return 1;
  if (/\bto Rabat\b|\bRabat\b|\bRBA\b/i.test(target.title ?? "")) return 4;
  if ((target.title ?? "").trim()) return 3;
  return 2;
}

export function selectGoogleFlightSearchPages(
  targets: CdpTarget[],
  search: GoogleFlightSearch,
): Array<CdpTarget & { webSocketDebuggerUrl: string }> {
  return targets
    .filter(
      (target): target is CdpTarget & { webSocketDebuggerUrl: string } =>
        matchesGoogleFlightSearchTarget(target, search) &&
        typeof target.webSocketDebuggerUrl === "string",
    )
    .sort((left, right) => targetQuality(right) - targetQuality(left));
}

async function fetchCdpTargets(): Promise<CdpTarget[]> {
  const response = await fetch(CDP_TARGETS_URL);
  if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status}`);
  return (await response.json()) as CdpTarget[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSearchTargets(
  searches: GoogleFlightSearch[],
  deadline: RunDeadline,
  maxMs: number,
): Promise<CdpTarget[]> {
  const waitMs = deadline.budgetMs(maxMs, TARGET_READY_POLL_MS);
  const stopAt = Date.now() + waitMs;
  let targets = await fetchCdpTargets();
  while (Date.now() < stopAt) {
    const missing = missingGoogleFlightSearches(targets, searches);
    if (missing.length === 0) return targets;
    await sleep(Math.min(TARGET_READY_POLL_MS, Math.max(0, stopAt - Date.now())));
    targets = await fetchCdpTargets();
  }
  return targets;
}

async function waitForTargetId(
  targetId: string,
  deadline: RunDeadline,
  maxMs: number,
): Promise<CdpTarget[]> {
  const waitMs = deadline.budgetMs(maxMs, TARGET_READY_POLL_MS);
  const stopAt = Date.now() + waitMs;
  let targets = await fetchCdpTargets();
  while (Date.now() < stopAt) {
    if (targets.some((target) => target.id === targetId && typeof target.webSocketDebuggerUrl === "string")) return targets;
    await sleep(Math.min(TARGET_READY_POLL_MS, Math.max(0, stopAt - Date.now())));
    targets = await fetchCdpTargets();
  }
  return targets;
}

async function waitForGoogleFlightsContent(client: CdpClient, deadline: RunDeadline): Promise<void> {
  const waitMs = deadline.budgetMs(10_000, PAGE_READY_POLL_MS);
  if (waitMs <= 0) return;

  await client.send("Runtime.evaluate", {
    returnByValue: true,
    awaitPromise: true,
    expression: `(async () => {
      const stopAt = Date.now() + ${waitMs};
      const hasSnapshotContent = () => {
        const body = document.body?.innerText || '';
        return /\\$\\s*([1-9]\\d{0,2}(?:,\\d{3})+|[1-9]\\d{3,}) round trip/i.test(body);
      };
      while (Date.now() < stopAt) {
        if (hasSnapshotContent()) return true;
        await new Promise(resolve => setTimeout(resolve, ${PAGE_READY_POLL_MS}));
      }
      return hasSnapshotContent();
    })()`,
  });
}

function shouldReloadCdpPage(snapshot: FlightSnapshot | null): boolean {
  const mode = (process.env.FLIGHT_PRICE_WATCH_CDP_RELOAD ?? "auto").toLowerCase();
  if (mode === "0" || mode === "false" || mode === "off") return false;
  if (mode === "1" || mode === "true" || mode === "on") return true;
  return snapshot === null;
}

async function readSnapshotFromPage(
  page: CdpTarget & { webSocketDebuggerUrl: string },
  search: GoogleFlightSearch,
  deadline: RunDeadline,
): Promise<FlightSnapshot | null> {
  const client = await connectCdp(page.webSocketDebuggerUrl);
  try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");

    let snapshot = await evaluateSnapshotFromPage(client, search);
    if (snapshot || !shouldReloadCdpPage(snapshot) || deadline.expired()) return snapshot;

    if (deadline.budgetMs(10_000, 1_000) > 0) {
      await client.send("Page.reload", { ignoreCache: true });
      await waitForGoogleFlightsContent(client, deadline);
      snapshot = await evaluateSnapshotFromPage(client, search);
    }
    return snapshot;
  } finally {
    client.close();
  }
}

async function evaluateSnapshotFromPage(
  client: CdpClient,
  search: GoogleFlightSearch,
): Promise<FlightSnapshot | null> {
  const result = await client.send("Runtime.evaluate", {
    returnByValue: true,
    awaitPromise: true,
    expression: `(async () => {
          const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
          const cleanAirlineText = value => (value || '')
            .replace(/([a-z])([A-Z])/g, '$1, $2')
            .replace(/\\s*,\\s*/g, ', ')
            .replace(/\\s+/g, ' ')
            .trim();
          const extractBestFlight = () => {
            const lines = (document.body.innerText || '').split('\\n').map(line => norm(line)).filter(Boolean);
            const priceIndex = lines.findIndex((line, index) => /^\\$[0-9,]+$/.test(line) && /round trip/i.test(lines[index + 1] || ''));
            if (priceIndex < 0) return '';
            const windowStart = Math.max(0, priceIndex - 10);
            const routeOffset = lines.slice(windowStart, priceIndex).findIndex(line => /\\b[A-Z]{3}\\s*[–-]\\s*[A-Z]{3}\\b/.test(line));
            if (routeOffset < 0) return '';
            const routeIndex = windowStart + routeOffset;
            const route = (lines[routeIndex] || '').replace(/\\s+/g, '');
            const duration = lines[routeIndex - 1] || '';
            const airlines = cleanAirlineText(lines[routeIndex - 2] || '');
            const arrival = lines[routeIndex - 3] || '';
            const departure = lines[routeIndex - 5] || '';
            const stops = lines[routeIndex + 1] || '';
            const connection = lines[routeIndex + 2] || '';
            const flightNumbers = [...new Set((lines.slice(windowStart, priceIndex).join(' ').match(/\\b[A-Z]{2}\\s?\\d{2,4}\\b/g) || []))];
            return [
              departure && arrival ? departure + '-' + arrival : '',
              airlines,
              route,
              duration,
              stops,
              /\\b[A-Z]{3}\\b/.test(connection) ? 'via ' + connection : '',
              flightNumbers.length ? 'flight ' + flightNumbers.join('/') : 'flight # not shown',
            ].filter(Boolean).join(', ');
          };
          const body = norm(document.body.innerText);
          const account = document.querySelector('[aria-label^="Google Account:"]')?.getAttribute('aria-label')?.replace(/\\s+/g, ' ').trim() || '';
          let sw = [...document.querySelectorAll('[role="switch"]')].find(el => /Track prices/i.test(el.getAttribute('aria-label') || ''));
          if (sw?.getAttribute('aria-checked') === 'false') {
            sw.click();
            const stopAt = Date.now() + 1500;
            while (Date.now() < stopAt && sw?.getAttribute('aria-checked') === 'false') {
              await new Promise(resolve => setTimeout(resolve, 150));
              sw = [...document.querySelectorAll('[role="switch"]')].find(el => /Track prices/i.test(el.getAttribute('aria-label') || ''));
            }
          }
          const trackLabel = sw?.getAttribute('aria-label') || '';
          const prices = [...body.matchAll(/\\$\\s*([1-9]\\d{0,2}(?:,\\d{3})+|[1-9]\\d{3,}) round trip/g)]
            .map(match => Number(match[1].replace(/,/g, '')))
            .filter(price => Number.isFinite(price) && price >= 1000 && price <= 50000)
            .filter((price, index, all) => all.indexOf(price) === index)
            .sort((a, b) => a - b);
          const routeMatch = trackLabel.match(/from (.*?) to (.*?) departing/i);
          const route = routeMatch
            ? routeMatch[1] + ' -> ' + routeMatch[2]
            : document.title.replace(/ \\| Google Flights$/, '').replace(/ to /, ' -> ');
          const insight = (body.match(/Prices are currently (high|typical|low|cheap|expensive)/i) || [])[0] || '';
          return { route, account, trackLabel, checked: sw?.getAttribute('aria-checked') || null, priceInsight: insight, prices, bestFlight: extractBestFlight(), url: location.href };
        })()`,
  });
  return extractSnapshotFromPage(result.result?.value, search);
}

function shouldLookupSelectedFlightNumbers(): boolean {
  const mode = (process.env.FLIGHT_PRICE_WATCH_FLIGHT_NUMBER_LOOKUP ?? "0").toLowerCase();
  return mode === "1" || mode === "true" || mode === "on";
}

async function readSelectedFlightNumbers(search: GoogleFlightSearch, deadline: RunDeadline): Promise<string[]> {
  if (!shouldLookupSelectedFlightNumbers()) return [];

  const opened = await openCdpTab(search);
  const openedId = opened?.id;
  try {
    if (!openedId) return [];
    const targets = await waitForTargetId(openedId, deadline, 10_000);
    const page = targets.find(
      (target): target is CdpTarget & { webSocketDebuggerUrl: string } =>
        target.id === openedId && typeof target.webSocketDebuggerUrl === "string",
    );
    if (!page) return [];

    const client = await connectCdp(page.webSocketDebuggerUrl);
    try {
      await client.send("Runtime.enable");
      const result = await client.send("Runtime.evaluate", {
        returnByValue: true,
        awaitPromise: true,
        expression: `(async () => {
          const button = [...document.querySelectorAll('button,[role="button"]')]
            .find(el => /Select flight/i.test(el.getAttribute('aria-label') || el.innerText || ''));
          if (!button) return '';
          button.scrollIntoView({ block: 'center' });
          button.click();
          const stopAt = Date.now() + 5000;
          while (Date.now() < stopAt && !location.href.includes('tfs=')) {
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          return location.href;
        })()`,
      });
      const selectedUrl = typeof result.result?.value === "string" ? result.result.value : "";
      return extractFlightNumbersFromGoogleFlightUrl(selectedUrl);
    } finally {
      client.close();
    }
  } finally {
    if (openedId) {
      await fetch(CDP_TARGETS_URL.replace(/\/json\/?$/, `/json/close/${openedId}`)).catch(() => undefined);
    }
  }
}

async function enrichSnapshotsWithFlightNumbers(snapshots: Map<string, FlightSnapshot>, deadline: RunDeadline): Promise<void> {
  if (!shouldLookupSelectedFlightNumbers()) return;
  for (const search of GOOGLE_FLIGHT_SEARCHES) {
    if (deadline.budgetMs(20_000, 15_000) <= 0) return;
    const snapshot = snapshots.get(search.route);
    if (!snapshot || !snapshot.bestFlight.includes("flight # not shown")) continue;
    let flightNumbers: string[] = [];
    for (let attempt = 0; attempt < 2 && flightNumbers.length === 0; attempt += 1) {
      if (deadline.budgetMs(15_000, 10_000) <= 0) break;
      flightNumbers = await readSelectedFlightNumbers(search, deadline).catch(() => []);
    }
    if (flightNumbers.length === 0) continue;
    snapshot.bestFlight = snapshot.bestFlight.replace("flight # not shown", `flight ${flightNumbers.join("/")}`);
  }
}

async function readBrowserSnapshots(): Promise<FlightSnapshot[]> {
  const deadline = configuredBrowserDeadline();
  let targets = await fetchCdpTargets();
  const missing = missingGoogleFlightSearches(targets);
  for (const search of missing) {
    if (deadline.budgetMs(5_000, 500) <= 0) break;
    await openCdpTab(search);
  }
  if (missing.length > 0) {
    targets = await waitForSearchTargets(missing, deadline, 5_000);
  }
  const snapshots = new Map<string, FlightSnapshot>();
  let missingSnapshots: GoogleFlightSearch[] = [];
  for (const search of GOOGLE_FLIGHT_SEARCHES) {
    for (const page of flightSearchPages(targets, search)) {
      if (deadline.expired()) break;
      const snapshot = await readSnapshotFromPage(page, search, deadline);
      if (snapshot) {
        snapshots.set(search.route, snapshot);
        break;
      }
    }
    if (!snapshots.has(search.route)) missingSnapshots.push(search);
  }

  if (missingSnapshots.length > 0) {
    for (const search of missingSnapshots) {
      if (deadline.budgetMs(7_000, 500) <= 0) break;
      await openCdpTab(search);
    }
    targets = await waitForSearchTargets(missingSnapshots, deadline, 7_000);

    const stillMissing: GoogleFlightSearch[] = [];
    for (const search of missingSnapshots) {
      for (const page of flightSearchPages(targets, search)) {
        if (deadline.expired()) break;
        const snapshot = await readSnapshotFromPage(page, search, deadline);
        if (snapshot) {
          snapshots.set(search.route, snapshot);
          break;
        }
      }
      if (!snapshots.has(search.route)) stillMissing.push(search);
    }
    missingSnapshots = stillMissing;
  }

  if (missingSnapshots.length > 0) {
    throw new Error(`missing parsable Google Flights snapshots: ${missingSnapshots.map((search) => search.route).join("; ")}`);
  }

  await enrichSnapshotsWithFlightNumbers(snapshots, deadline);

  return GOOGLE_FLIGHT_SEARCHES.map((search) => snapshots.get(search.route)).filter(
    (snapshot): snapshot is FlightSnapshot => Boolean(snapshot),
  );
}

function buildSnapshotFailure(error: Error | string): string {
  const detail = error instanceof Error ? error.message : String(error);
  return [
    "✈️ Rabat Flights - watcher degraded",
    "Gmail has no Google Flights emails, and the browser price snapshot failed.",
    `Detail: ${detail.slice(0, 180)}`,
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
    const date = todayEt();
    try {
      const snapshots = await readBrowserSnapshots();
      if (shouldSendSnapshot(sent, date, snapshots)) {
        writeSentState({
          ...sent,
          lastSnapshotDate: date,
          lastSnapshotPrices: snapshotPrices(snapshots),
        });
        console.log(buildSnapshotMessage(snapshots));
        return;
      }
    } catch (error) {
      if (sent.lastSnapshotFailureDate !== date) {
        writeSentState({ ...sent, lastSnapshotFailureDate: date });
        console.log(buildSnapshotFailure(error instanceof Error ? error : String(error)));
        return;
      }
    }

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
    writeSentState({ ...sent, sentMessageIds: [...sent.sentMessageIds, ...newlySeen] });
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
