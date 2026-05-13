#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";

export type IntelCategory = "cyber" | "tech" | "finance" | "markets" | "housing";

export type FeedConfig = {
  name: string;
  category: IntelCategory;
  url: string;
};

export type IntelItem = {
  title: string;
  link: string;
  source: string;
  category: IntelCategory;
  publishedAt?: string;
  score: number;
};

export type IntelBrief = {
  generatedAt: string;
  status: "ok" | "degraded";
  errors: string[];
  items: IntelItem[];
};

type IntelSectionOptions = {
  offsetPerCategory?: number;
};

export const DEFAULT_FEEDS: FeedConfig[] = [
  { name: "BleepingComputer", category: "cyber", url: "https://www.bleepingcomputer.com/feed/" },
  { name: "KrebsOnSecurity", category: "cyber", url: "https://krebsonsecurity.com/feed/" },
  { name: "CISA", category: "cyber", url: "https://www.cisa.gov/news.xml" },
  { name: "Hacker News", category: "tech", url: "https://hnrss.org/frontpage" },
  { name: "TechCrunch", category: "tech", url: "https://techcrunch.com/feed/" },
  { name: "Ars Technica", category: "tech", url: "https://feeds.arstechnica.com/arstechnica/index" },
  { name: "CNBC Top News", category: "finance", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  { name: "CNBC Finance", category: "finance", url: "https://www.cnbc.com/id/10000664/device/rss/rss.html" },
  { name: "CNBC Markets", category: "markets", url: "https://www.cnbc.com/id/10001147/device/rss/rss.html" },
  { name: "Calculated Risk", category: "housing", url: "https://www.calculatedriskblog.com/feeds/posts/default" },
  { name: "HousingWire", category: "housing", url: "https://www.housingwire.com/feed/" },
];

const CATEGORY_LABELS: Record<IntelCategory, string> = {
  cyber: "Cyber",
  tech: "Tech",
  finance: "Finance",
  markets: "Markets",
  housing: "Housing",
};

const IMPACT_TERMS = [
  "breach",
  "ransomware",
  "zero-day",
  "vulnerability",
  "exploit",
  "fed",
  "rates",
  "inflation",
  "jobs",
  "earnings",
  "guidance",
  "mortgage",
  "housing",
  "ai",
  "chip",
  "tariff",
  "oil",
  "treasury",
  "yield",
];

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value: string): string {
  return decodeEntities(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function tagValue(block: string, tag: string): string {
  const direct = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1];
  if (direct) return stripTags(direct);
  if (tag === "link") {
    const href = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i)?.[1];
    if (href) return decodeEntities(href);
  }
  return "";
}

function parseDate(block: string): string | undefined {
  const raw = tagValue(block, "pubDate") || tagValue(block, "published") || tagValue(block, "updated");
  if (!raw) return undefined;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : undefined;
}

export function parseFeedXml(xml: string, feed: FeedConfig): IntelItem[] {
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? [];
  return blocks
    .map((block) => {
      const title = tagValue(block, "title");
      const link = tagValue(block, "link") || tagValue(block, "id");
      if (!title || !link) return null;
      return scoreItem({
        title,
        link,
        source: feed.name,
        category: feed.category,
        publishedAt: parseDate(block),
        score: 0,
      });
    })
    .filter((item): item is IntelItem => Boolean(item));
}

export function scoreItem(item: IntelItem, now = new Date()): IntelItem {
  const haystack = item.title.toLowerCase();
  let score = 10;
  for (const term of IMPACT_TERMS) {
    if (haystack.includes(term)) score += 4;
  }

  if (item.publishedAt) {
    const ageHours = (now.getTime() - Date.parse(item.publishedAt)) / 3_600_000;
    if (Number.isFinite(ageHours)) {
      if (ageHours <= 6) score += 8;
      else if (ageHours <= 18) score += 5;
      else if (ageHours <= 36) score += 2;
      else if (ageHours > 96) score -= 6;
    }
  }

  if (item.category === "markets" || item.category === "housing") score += 2;
  return { ...item, score };
}

function normalizedTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function dedupeAndRank(items: IntelItem[], limitPerCategory = 3): IntelItem[] {
  const seen = new Set<string>();
  const ranked = [...items].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const counts = new Map<IntelCategory, number>();
  const out: IntelItem[] = [];

  for (const item of ranked) {
    const key = normalizedTitle(item.title);
    if (seen.has(key)) continue;
    seen.add(key);
    const count = counts.get(item.category) ?? 0;
    if (count >= limitPerCategory) continue;
    counts.set(item.category, count + 1);
    out.push(item);
  }

  return out;
}

async function fetchText(url: string, timeoutMs = 12_000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "cortana-morning-intel/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function collectMorningIntelBrief(feeds = DEFAULT_FEEDS, now = new Date()): Promise<IntelBrief> {
  const errors: string[] = [];
  const settled = await Promise.allSettled(
    feeds.map(async (feed) => {
      const xml = await fetchText(feed.url);
      return parseFeedXml(xml, feed).map((item) => scoreItem(item, now));
    }),
  );

  const items: IntelItem[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      errors.push(`${feeds[index]?.name ?? "feed"}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  });

  return {
    generatedAt: now.toISOString(),
    status: items.length > 0 ? "ok" : "degraded",
    errors,
    items: dedupeAndRank(items, 12),
  };
}

function itemLine(item: IntelItem): string {
  return `${item.title} (${item.source}) ${item.link}`;
}

function selectWindow<T>(items: T[], limit: number, offset: number): T[] {
  if (items.length <= limit) return items.slice(0, limit);
  const start = Math.min(offset, Math.max(0, items.length - limit));
  return items.slice(start, start + limit);
}

export function buildMorningIntelSections(brief: IntelBrief, options: IntelSectionOptions = {}): { news: string[]; markets: string[] } {
  if (brief.items.length === 0) {
    const reason = brief.errors[0] ? ` (${brief.errors[0]})` : "";
    return {
      news: [`News unavailable${reason}.`],
      markets: [`Market snapshot unavailable${reason}.`],
    };
  }

  const newsItems = brief.items.filter((item) => item.category === "cyber" || item.category === "tech" || item.category === "finance");
  const marketItems = brief.items.filter((item) => item.category === "markets" || item.category === "housing");
  const offset = options.offsetPerCategory ?? 0;

  return {
    news: selectWindow(newsItems, 4, offset).map((item) => `${CATEGORY_LABELS[item.category]}: ${itemLine(item)}`),
    markets: selectWindow(marketItems, 4, offset).map((item) => `${CATEGORY_LABELS[item.category]}: ${itemLine(item)}`),
  };
}

export function buildMorningIntelCategorySections(
  brief: IntelBrief,
  limitPerCategory = 3,
  options: IntelSectionOptions = {},
): Record<IntelCategory, string[]> {
  const sections: Record<IntelCategory, string[]> = {
    cyber: [],
    tech: [],
    finance: [],
    markets: [],
    housing: [],
  };

  if (brief.items.length === 0) {
    const reason = brief.errors[0] ? ` (${brief.errors[0]})` : "";
    return {
      cyber: [`Cyber unavailable${reason}.`],
      tech: [`Tech unavailable${reason}.`],
      finance: [`Finance unavailable${reason}.`],
      markets: [`Markets unavailable${reason}.`],
      housing: [`Housing unavailable${reason}.`],
    };
  }

  for (const category of Object.keys(sections) as IntelCategory[]) {
    const categoryItems = brief.items.filter((item) => item.category === category);
    sections[category] = selectWindow(categoryItems, limitPerCategory, options.offsetPerCategory ?? 0).map((item) => `${itemLine(item)}`);
    if (sections[category].length === 0) {
      sections[category] = [`${CATEGORY_LABELS[category]} unavailable.`];
    }
  }

  return sections;
}

export function renderMorningIntelBrief(brief: IntelBrief): string {
  const sections = buildMorningIntelSections(brief);
  const lines = ["🗞️ Intel - RSS Brief", ""];
  lines.push("News:");
  lines.push(...sections.news.map((item) => `• ${item}`));
  lines.push("");
  lines.push("Markets / Housing:");
  lines.push(...sections.markets.map((item) => `• ${item}`));
  if (brief.errors.length > 0) {
    lines.push("");
    lines.push(`Feed warnings: ${brief.errors.slice(0, 2).join("; ")}`);
  }
  return lines.join("\n");
}

function sendTelegram(message: string): void {
  const proc = spawnSync("openclaw", ["message", "send", "--channel", "telegram", "--target", "8171372724", "--message", message, "--json"], {
    encoding: "utf8",
  });
  if ((proc.status ?? 1) !== 0) {
    throw new Error((proc.stderr || proc.stdout || "telegram send failed").trim());
  }
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const json = argv.includes("--json");
  const telegram = argv.includes("--telegram");
  const brief = await collectMorningIntelBrief();
  const rendered = renderMorningIntelBrief(brief);

  if (telegram) sendTelegram(rendered);
  process.stdout.write(json ? `${JSON.stringify(brief, null, 2)}\n` : `${rendered}\n`);
  if (brief.status !== "ok") process.exitCode = 1;
}

if (process.argv[1]?.endsWith("morning-intel-brief.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
