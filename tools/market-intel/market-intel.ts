#!/usr/bin/env npx tsx

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { resolveRepoPath } from "../lib/paths.js";

const ROOT = resolveRepoPath();
const STOCK_ANALYSIS_DIR = path.join(ROOT, "skills", "stock-analysis");
const MARKET_STATUS_SCRIPT = path.join(ROOT, "skills", "markets", "check_market_status.sh");
const ALPACA_PORTFOLIO_URL = "http://localhost:3033/alpaca/portfolio";
const ALPACA_STATS_URL = "http://localhost:3033/alpaca/stats";
const BIRD_SECRET_ENV = path.join(os.homedir(), ".config", "bird", "secret.env");

const BULLISH_WORDS = new Set([
  "bullish",
  "buy",
  "long",
  "calls",
  "breakout",
  "rally",
  "beat",
  "upside",
  "moon",
  "rip",
  "accumulate",
  "upgrade",
  "outperform",
  "strong",
  "squeeze",
  "green",
]);

const BEARISH_WORDS = new Set([
  "bearish",
  "sell",
  "short",
  "puts",
  "dump",
  "crash",
  "miss",
  "downside",
  "rug",
  "fade",
  "downgrade",
  "underperform",
  "weak",
  "red",
  "recession",
  "overvalued",
]);

const TICKER_RE = /\$?[A-Z]{2,5}/g;
let birdOk: boolean | null = null;

type Json = Record<string, any>;

type RunResult = { code: number; stdout: string; stderr: string };

function run(cmd: string[], timeoutSeconds = 30, cwd?: string, env?: NodeJS.ProcessEnv): RunResult {
  const proc = spawnSync(cmd[0], cmd.slice(1), {
    encoding: "utf8",
    timeout: timeoutSeconds * 1000,
    cwd,
    env,
  });
  return { code: proc.status ?? 1, stdout: (proc.stdout ?? "").trim(), stderr: (proc.stderr ?? "").trim() };
}

function readSimpleEnvFile(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function birdEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (env.AUTH_TOKEN && env.CT0) return env;
  if (!fs.existsSync(BIRD_SECRET_ENV)) return env;

  try {
    const parsed = readSimpleEnvFile(BIRD_SECRET_ENV);
    if (!env.AUTH_TOKEN && parsed.AUTH_TOKEN) env.AUTH_TOKEN = parsed.AUTH_TOKEN;
    if (!env.CT0 && parsed.CT0) env.CT0 = parsed.CT0;
    if (!env.SWEETISTICS_API_KEY && parsed.SWEETISTICS_API_KEY) {
      env.SWEETISTICS_API_KEY = parsed.SWEETISTICS_API_KEY;
    }
  } catch {
    // Fall back to the ambient environment if the local bird secret file is unreadable.
  }

  return env;
}

async function fetchJson(url: string, timeoutSeconds = 15): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "market-intel/1.0" }, signal: controller.signal });
    const body = await res.text();
    return JSON.parse(body);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url: string, timeoutSeconds = 15): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": "market-intel/1.0" }, signal: controller.signal });
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function stockQuote(symbol: string): Json {
  const cmd = ["npx", "tsx", "src/stock_analysis/main.ts", "analyze", symbol.toUpperCase(), "--json"];
  const { code, stdout, stderr } = run(cmd, 30, STOCK_ANALYSIS_DIR);
  if (code !== 0 || !stdout) throw new Error(`stock-analysis failed: ${stderr || stdout}`);
  const data = JSON.parse(stdout) as Json;
  if (data.error) throw new Error(String(data.error));
  return data;
}

function num(v: any): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return n;
}

async function fromAlphaOverview(symbol: string): Promise<Json> {
  const q = encodeURIComponent(symbol.toUpperCase());
  const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${q}&apikey=demo`;
  const payload = await fetchJson(url);
  if (!payload || typeof payload !== "object" || payload.Note || payload.Information) {
    throw new Error("alpha-overview unavailable");
  }

  const mcap = num(payload.MarketCapitalization);
  const pe = num(payload.PERatio);
  const fwdPe = num(payload.ForwardPE);
  const eps = num(payload.EPS);
  const divYield = num(payload.DividendYield);
  const beta = num(payload.Beta);
  const hi = num(payload["52WeekHigh"]);
  const lo = num(payload["52WeekLow"]);
  const revGrowth = num(payload.QuarterlyRevenueGrowthYOY);
  const profitMargin = num(payload.ProfitMargin);

  if ([mcap, pe, eps, hi, lo, beta].every((v) => v == null)) throw new Error("alpha-overview missing fields");

  return {
    market_cap: mcap,
    pe,
    forward_pe: fwdPe,
    dividend_yield: divYield,
    beta,
    fifty_two_week_high: hi,
    fifty_two_week_low: lo,
    eps,
    revenue_growth: revGrowth,
    profit_margins: profitMargin,
    recommendation: null,
    source: "alpha_vantage_overview",
  };
}

async function fromAlphaGlobalQuote(symbol: string): Promise<Json> {
  const q = encodeURIComponent(symbol.toUpperCase());
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${q}&apikey=demo`;
  const payload = await fetchJson(url);
  const quote = payload && typeof payload === "object" ? payload["Global Quote"] : null;
  if (!quote || typeof quote !== "object") throw new Error("alpha-global-quote unavailable");

  const hi = num(quote["03. high"]);
  const lo = num(quote["04. low"]);
  if (hi == null && lo == null) throw new Error("alpha-global-quote missing high/low");

  return {
    market_cap: null,
    pe: null,
    forward_pe: null,
    dividend_yield: null,
    beta: null,
    fifty_two_week_high: hi,
    fifty_two_week_low: lo,
    eps: null,
    revenue_growth: null,
    profit_margins: null,
    recommendation: null,
    source: "alpha_vantage_global_quote",
  };
}

function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (!lines.length) return [];
  const header = lines[0].split(",");
  const rows: Array<Record<string, string>> = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((h, idx) => {
      row[h] = cols[idx] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

async function fromStooq(symbol: string): Promise<Json> {
  const stooqSymbol = `${symbol.toLowerCase()}.us`;
  const url = `https://stooq.com/q/d/l/?s=${stooqSymbol}&i=d`;
  const text = await fetchText(url, 20);
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("stooq unavailable");

  const usable = rows.filter((r) => r.Close && r.Close !== "N/D" && r.Close !== "-");
  if (!usable.length) throw new Error("stooq has no usable rows");

  const recent = usable.length >= 252 ? usable.slice(-252) : usable;
  const closes = recent
    .map((r) => num(r.Close))
    .filter((v): v is number => v != null);
  if (!closes.length) throw new Error("stooq close parse failed");

  return {
    market_cap: null,
    pe: null,
    forward_pe: null,
    dividend_yield: null,
    beta: null,
    fifty_two_week_high: Math.max(...closes),
    fifty_two_week_low: Math.min(...closes),
    eps: null,
    revenue_growth: null,
    profit_margins: null,
    recommendation: null,
    source: "stooq",
  };
}

async function fromAlpacaService(symbol: string): Promise<Json> {
  const sym = symbol.toUpperCase();
  const candidates = [
    `http://localhost:3033/alpaca/snapshot/${sym}`,
    `http://localhost:3033/alpaca/snapshot?symbol=${sym}`,
    `http://localhost:3033/alpaca/quote/${sym}`,
    `http://localhost:3033/alpaca/quote?symbol=${sym}`,
  ];

  for (const url of candidates) {
    let payload: any;
    try {
      payload = await fetchJson(url, 5);
    } catch {
      continue;
    }

    if (!payload || typeof payload !== "object") continue;
    const hi = num(payload.high ?? payload.dailyBar?.h ?? payload.bar?.h);
    const lo = num(payload.low ?? payload.dailyBar?.l ?? payload.bar?.l);
    if (hi == null && lo == null) continue;

    return {
      market_cap: null,
      pe: null,
      forward_pe: null,
      dividend_yield: null,
      beta: null,
      fifty_two_week_high: hi,
      fifty_two_week_low: lo,
      eps: null,
      revenue_growth: null,
      profit_margins: null,
      recommendation: null,
      source: "alpaca_service",
    };
  }

  throw new Error("alpaca market-data endpoint unavailable");
}

async function stockFundamentals(symbol: string): Promise<Json> {
  const errors: string[] = [];
  const sources: Array<[string, (s: string) => Promise<Json>]> = [
    ["stooq", fromStooq],
    ["alpha_vantage_overview", fromAlphaOverview],
    ["alpha_vantage_global_quote", fromAlphaGlobalQuote],
    ["alpaca_service", fromAlpacaService],
  ];

  for (const [name, fn] of sources) {
    try {
      const data = await fn(symbol);
      data.provider = name;
      if (errors.length) data.errors = errors;
      return data;
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return {
    market_cap: null,
    pe: null,
    forward_pe: null,
    dividend_yield: null,
    beta: null,
    fifty_two_week_high: null,
    fifty_two_week_low: null,
    eps: null,
    revenue_growth: null,
    profit_margins: null,
    recommendation: null,
    provider: "none",
    errors,
  };
}

function parseBirdJson(raw: string): Array<Record<string, any>> {
  try {
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data.filter((x) => x && typeof x === "object");
    if (data && typeof data === "object") {
      if (Array.isArray(data.tweets)) return data.tweets.filter((x: any) => x && typeof x === "object");
      return [data];
    }
  } catch {
    return [];
  }
  return [];
}

function pick(obj: Json, ...paths: string[]): any {
  for (const p of paths) {
    let cur: any = obj;
    let ok = true;
    for (const key of p.split(".")) {
      if (cur && typeof cur === "object" && key in cur) {
        cur = cur[key];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && cur != null && cur !== "") return cur;
  }
  return null;
}

function normalizeTweet(t: Json): Json {
  let text = pick(t, "full_text", "text", "legacy.full_text", "legacy.text") ?? "";
  text = String(text).replace(/\s+/g, " ").trim();
  const username = pick(t, "user.screen_name", "user.username", "author.username", "legacy.user.screen_name") ?? "unknown";
  const created = pick(t, "created_at", "legacy.created_at") ?? "";
  const tid = pick(t, "id_str", "rest_id", "id");
  const url = tid ? `https://x.com/${username}/status/${tid}` : "";
  return { text, username: String(username), created_at: String(created), url };
}

function ensureBirdReady(): boolean {
  if (birdOk !== null) return birdOk;
  const { code, stdout, stderr } = run(["bird", "check"], 20, undefined, birdEnv());
  const merged = `${stdout}\n${stderr}`.toLowerCase();
  birdOk = code === 0 && merged.includes("ok");
  if (!birdOk) {
    console.error("⚠️ bird check failed; skipping X sentiment. Cookie auth likely needs refresh.");
  }
  return birdOk;
}

function birdSearch(query: string, count: number): Json[] {
  if (!ensureBirdReady()) return [];
  const cmd = ["bird", "search", "--json", "-n", String(count), query];
  const { code, stdout } = run(cmd, 45, undefined, birdEnv());
  if (code !== 0) return [];
  const tweets = parseBirdJson(stdout).map(normalizeTweet);
  return tweets.filter((t) => t.text);
}

function sentimentLabel(text: string): string {
  const words = new Set(String(text).toLowerCase().match(/[a-zA-Z']+/g) ?? []);
  const bull = Array.from(words).filter((w) => BULLISH_WORDS.has(w)).length;
  const bear = Array.from(words).filter((w) => BEARISH_WORDS.has(w)).length;
  if (bull > bear) return "bullish";
  if (bear > bull) return "bearish";
  return "neutral";
}

function sentimentSummary(tweets: Json[]): Json {
  if (!tweets.length) {
    return { counts: { bullish: 0, bearish: 0, neutral: 0 }, bearish_pct: 0.0, mood: "unknown" };
  }

  const labels = tweets.map((t) => sentimentLabel(String(t.text ?? "")));
  const counts = { bullish: 0, bearish: 0, neutral: 0 };
  for (const l of labels) {
    if (l === "bullish") counts.bullish += 1;
    else if (l === "bearish") counts.bearish += 1;
    else counts.neutral += 1;
  }
  const total = Math.max(labels.length, 1);
  const bearishPct = (counts.bearish / total) * 100;
  let mood = "neutral";
  if (counts.bullish / total >= 0.6) mood = "bullish";
  else if (bearishPct >= 60) mood = "bearish";

  return {
    counts,
    bearish_pct: Math.round(bearishPct * 10) / 10,
    mood,
  };
}

function fmtNum(v: any): string {
  if (v == null) return "n/a";
  if (typeof v === "number") {
    if (Math.abs(v) >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
    if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  return String(v);
}

function topTickerMentions(tweets: Json[], limit = 5): string[] {
  const bag = new Map<string, number>();
  for (const t of tweets) {
    const text = String(t.text ?? "");
    const matches = text.match(TICKER_RE) ?? [];
    for (const tok of matches) {
      const sym = tok.replace(/^\$/, "").toUpperCase();
      if (sym.length >= 2 && sym.length <= 5) {
        bag.set(sym, (bag.get(sym) ?? 0) + 1);
      }
    }
  }
  return Array.from(bag.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k]) => k);
}

async function modeTicker(symbol: string): Promise<string> {
  const sym = symbol.toUpperCase();
  const quote = stockQuote(sym);
  const fundamentals = await stockFundamentals(sym);

  const cashtagQuery = `\\$${sym}`;
  const sentimentTweets = birdSearch(cashtagQuery, 20);
  const keyAccountQ = `(from:unusual_whales OR from:DeItaone) \\${sym}`;
  const keyMentions = birdSearch(keyAccountQ, 20);
  const sent = sentimentSummary(sentimentTweets);

  const lines: string[] = [];
  lines.push(`📊 Market Intel: ${sym}`);
  lines.push(`Price: $${quote.price} (${quote.change_percent}%) [${quote.signal}]`);
  lines.push(
    "Key metrics: " +
      `MktCap ${fmtNum(fundamentals.market_cap)} | ` +
      `P/E ${fmtNum(fundamentals.pe)} | ` +
      `Fwd P/E ${fmtNum(fundamentals.forward_pe)} | ` +
      `EPS ${fmtNum(fundamentals.eps)}`
  );
  lines.push(
    `Range: 52W High ${fmtNum(fundamentals.fifty_two_week_high)} | 52W Low ${fmtNum(
      fundamentals.fifty_two_week_low
    )}`
  );
  lines.push(`Fundamentals source: ${fundamentals.provider ?? "unknown"}`);
  lines.push(
    "X sentiment (20): " +
      `${sent.mood} | bullish ${sent.counts.bullish} / bearish ${sent.counts.bearish} / neutral ${sent.counts.neutral}`
  );

  if (keyMentions.length) {
    lines.push("Notable account mentions:");
    for (const t of keyMentions.slice(0, 5)) {
      const snippet = t.text.slice(0, 180);
      lines.push(`- @${t.username}: ${snippet}${t.text.length > 180 ? "…" : ""}`);
    }
  } else {
    lines.push("Notable account mentions: none found (or bird auth unavailable).");
  }

  return lines.join("\n");
}

async function modePortfolio(): Promise<string> {
  const data = await fetchJson(ALPACA_PORTFOLIO_URL);
  const positions = Array.isArray(data?.positions) ? data.positions : [];

  const lines: string[] = ["💼 Portfolio Sentiment Scan"];
  if (!positions.length) {
    lines.push("No open positions in Alpaca.");
    return lines.join("\n");
  }

  const flagged: string[] = [];
  for (const p of positions) {
    const symbol = String(p.symbol ?? "").toUpperCase();
    const qty = p.qty;
    const mv = p.market_value;
    const tweets = birdSearch(`\\$${symbol}`, 5);
    const sent = sentimentSummary(tweets);
    if (sent.bearish_pct > 60) flagged.push(symbol);
    lines.push(
      `- ${symbol}: qty ${qty}, mv $${mv}, mood ${sent.mood} ` +
        `(bearish ${sent.bearish_pct}%, n=${sent.counts.bullish + sent.counts.bearish + sent.counts.neutral})`
    );
  }

  if (flagged.length) {
    lines.push("⚠️ Bearish risk flags (>60% bearish): " + flagged.join(", "));
  } else {
    lines.push("✅ No bearish sentiment flags above 60%.");
  }

  return lines.join("\n");
}

function marketStatus(): string {
  if (fs.existsSync(MARKET_STATUS_SCRIPT)) {
    const { code, stdout } = run([MARKET_STATUS_SCRIPT], 10);
    if (code === 0 && stdout) return stdout;
  }
  return "UNKNOWN";
}

async function modePulse(): Promise<string> {
  const status = marketStatus();
  const broad = birdSearch("stock market today OR SPY OR QQQ", 20);
  const key = birdSearch("from:DeItaone OR from:unusual_whales", 20);
  const sent = sentimentSummary(broad);
  const movers = topTickerMentions([...broad, ...key], 6);

  const lines: string[] = ["🌐 Market Pulse"];
  lines.push(`Market status: ${status}`);
  lines.push(
    `Market mood: ${sent.mood} (bullish ${sent.counts.bullish}, bearish ${sent.counts.bearish}, neutral ${sent.counts.neutral})`
  );
  lines.push("Top movers mentioned: " + (movers.length ? movers.join(", ") : "none"));

  lines.push("Breaking/news flow (DeItaone + unusual_whales):");
  if (key.length) {
    for (const t of key.slice(0, 6)) {
      const snippet = t.text.slice(0, 180);
      lines.push(`- @${t.username}: ${snippet}${t.text.length > 180 ? "…" : ""}`);
    }
  } else {
    lines.push("- No key-account pulls (bird auth missing or no fresh posts)." );
  }

  return lines.join("\n");
}

type Args = { ticker?: string | null; portfolio: boolean; pulse: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { ticker: null, portfolio: false, pulse: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--ticker":
        args.ticker = argv[i + 1] ?? null;
        i += 1;
        break;
      case "--portfolio":
        args.portfolio = true;
        break;
      case "--pulse":
        args.pulse = true;
        break;
      default:
        break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const selected = [Boolean(args.ticker), args.portfolio, args.pulse].filter(Boolean).length;
  if (selected !== 1) {
    console.error("Usage: market-intel.ts --ticker <SYM> | --portfolio | --pulse");
    process.exit(2);
  }

  try {
    if (args.ticker) {
      console.log(await modeTicker(args.ticker));
    } else if (args.portfolio) {
      console.log(await modePortfolio());
    } else if (args.pulse) {
      console.log(await modePulse());
    } else {
      process.exit(2);
    }
    process.exit(0);
  } catch (e) {
    console.log(`❌ market-intel failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
