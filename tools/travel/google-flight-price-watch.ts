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
export type GoogleFlightSearch = {
  route: string;
  url: string;
  urlNeedle: string;
};

const GOOGLE_FLIGHT_SEARCHES: GoogleFlightSearch[] = [
  {
    route: "New York -> Rabat",
    url: "https://www.google.com/travel/flights?q=Flights%20from%20JFK%20to%20RBA%20August%2012%202026%20to%20August%2020%202026%20business%20class%202%20adults",
    urlNeedle: "Flights%20from%20JFK%20to%20RBA%20August%2012%202026%20to%20August%2020%202026%20business%20class%202%20adults",
  },
  {
    route: "Newark -> Rabat",
    url: "https://www.google.com/travel/flights?q=Flights%20from%20EWR%20to%20RBA%20August%2012%202026%20to%20August%2020%202026%20business%20class%202%20adults",
    urlNeedle: "Flights%20from%20EWR%20to%20RBA%20August%2012%202026%20to%20August%2020%202026%20business%20class%202%20adults",
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
  url: string;
};

type CdpTarget = {
  title?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type CdpClient = {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  close(): void;
};

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

function formatPrice(price: number | null): string {
  return price == null ? "unknown" : `$${price.toLocaleString("en-US")}`;
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
  const ordered = [...snapshots].sort((a, b) => a.route.localeCompare(b.route));
  const lowest = ordered
    .map((snapshot) => snapshot.lowestPrice)
    .filter((price): price is number => typeof price === "number")
    .sort((a, b) => a - b)[0] ?? null;
  const lines = [
    "✈️ Rabat Flights - price snapshot",
    "Google has not emailed yet; live browser check is working.",
    ...ordered.map((snapshot) => {
      const insight = snapshot.priceInsight ? `, ${snapshot.priceInsight}` : "";
      const tracking = snapshot.trackingEnabled ? "tracking on" : "tracking off";
      return `${snapshot.route}: ${formatPrice(snapshot.lowestPrice)} total for 2 business seats${insight}, ${tracking}`;
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
  const priceText = lowest == null ? "unknown" : `$${lowest.toLocaleString("en-US")}`;
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
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
    else waiter?.resolve(message.result);
  };

  return {
    send(method: string, params: Record<string, unknown> = {}) {
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

async function openCdpTab(search: GoogleFlightSearch): Promise<void> {
  const url = buildCdpNewTabUrl(CDP_TARGETS_URL, search.url);
  let response = await fetch(url, { method: "PUT" });
  if (!response.ok && response.status === 405) {
    response = await fetch(url);
  }
  if (!response.ok) {
    throw new Error(`failed to open ${search.route}: HTTP ${response.status}`);
  }
}

function extractSnapshotFromPage(value: any): FlightSnapshot | null {
  const route = typeof value?.route === "string" ? value.route : "";
  const prices = Array.isArray(value?.prices) ? value.prices.filter((price: unknown) => typeof price === "number") : [];
  if (!route || prices.length === 0) return null;
  return {
    route,
    account: typeof value.account === "string" ? value.account : "",
    trackLabel: typeof value.trackLabel === "string" ? value.trackLabel : "",
    trackingEnabled: value.checked === "true",
    priceInsight: typeof value.priceInsight === "string" ? value.priceInsight : "",
    lowestPrice: prices[0] ?? null,
    prices,
    url: typeof value.url === "string" ? value.url : "",
  };
}

async function readBrowserSnapshots(): Promise<FlightSnapshot[]> {
  let response = await fetch(CDP_TARGETS_URL);
  if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status}`);
  let targets = (await response.json()) as CdpTarget[];
  const missing = missingGoogleFlightSearches(targets);
  for (const search of missing) {
    await openCdpTab(search);
  }
  if (missing.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    response = await fetch(CDP_TARGETS_URL);
    if (!response.ok) throw new Error(`CDP target refresh failed: HTTP ${response.status}`);
    targets = (await response.json()) as CdpTarget[];
  }
  const pages = targets.filter(
    (target) =>
      target.type === "page" &&
      typeof target.url === "string" &&
      target.url.includes("google.com/travel/flights") &&
      GOOGLE_FLIGHT_SEARCHES.some((search) => matchesGoogleFlightSearchTarget(target, search)) &&
      typeof target.webSocketDebuggerUrl === "string",
  );
  if (pages.length === 0) {
    throw new Error("no open Google Flights Rabat/RBA tabs found");
  }

  const snapshots: FlightSnapshot[] = [];
  for (const page of pages) {
    const client = await connectCdp(page.webSocketDebuggerUrl as string);
    try {
      await client.send("Runtime.enable");
      await client.send("Page.enable");
      if (process.env.FLIGHT_PRICE_WATCH_CDP_RELOAD !== "0") {
        await client.send("Page.reload", { ignoreCache: true });
        await new Promise((resolve) => setTimeout(resolve, 9000));
      }
      const result = await client.send("Runtime.evaluate", {
        returnByValue: true,
        awaitPromise: true,
        expression: `(() => {
          const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
          const body = norm(document.body.innerText);
          const account = document.querySelector('[aria-label^="Google Account:"]')?.getAttribute('aria-label')?.replace(/\\s+/g, ' ').trim() || '';
          const sw = [...document.querySelectorAll('[role="switch"]')].find(el => /Track prices/i.test(el.getAttribute('aria-label') || ''));
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
          return { route, account, trackLabel, checked: sw?.getAttribute('aria-checked') || null, priceInsight: insight, prices, url: location.href };
        })()`,
      });
      const snapshot = extractSnapshotFromPage(result.result.value);
      if (snapshot) snapshots.push(snapshot);
    } finally {
      client.close();
    }
  }

  if (snapshots.length === 0) {
    throw new Error("open Google Flights tabs did not expose parsable round-trip prices");
  }

  return snapshots;
}

function buildSnapshotFailure(error: unknown): string {
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
        console.log(buildSnapshotFailure(error));
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
