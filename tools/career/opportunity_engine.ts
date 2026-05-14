#!/usr/bin/env npx tsx

import { runPsql } from "../lib/db.js";

const DB_NAME = "cortana";
const SOURCE = "opportunity_engine";

const STACK_KEYWORDS = [
  "typescript",
  "react",
  "tanstack",
  "go",
  "golang",
  "security",
  "architecture",
  "reliability",
  "prisma",
  "auth",
];

const GOALS: Record<string, string[]> = {
  masters_program: ["paper", "research", "architecture", "distributed", "security", "analysis"],
  resilience_role: ["security", "incident", "resilience", "detection", "reliability", "threat"],
  side_projects: ["typescript", "react", "go", "api", "automation", "oauth", "product"],
};

const FEEDS = [
  "https://github.blog/security/feed/",
  "https://krebsonsecurity.com/feed/",
  "https://www.cisa.gov/cybersecurity-advisories/all.xml",
  "https://martinfowler.com/feed.atom",
  "https://www.infoq.com/feed/architecture-design/",
];

type Opportunity = {
  title: string;
  source: string;
  url: string;
  summary: string;
  tags: string[];
  goal_match: Record<string, number>;
  roi: number;
  effort: number;
  confidence: number;
  why_now: string;
  execution_plan: string[];
};

function sqlEscape(value: string): string {
  return (value || "").replace(/'/g, "''");
}

function runPsqlText(sql: string): string {
  const proc = runPsql(sql, {
    db: DB_NAME,
    args: ["-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A"],
    stdio: "pipe",
  });
  if (proc.status !== 0) {
    throw new Error((proc.stderr || "").trim() || "psql failed");
  }
  return (proc.stdout || "").trim();
}

function logEvent(eventType: string, message: string, severity: string, metadata: Record<string, any>, dryRun: boolean): void {
  if (dryRun) return;
  const sql =
    "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES " +
    `('${sqlEscape(eventType)}','${SOURCE}','${sqlEscape(severity)}','${sqlEscape(message)}','${sqlEscape(
      JSON.stringify(metadata),
    )}'::jsonb);`;
  runPsqlText(sql);
}

async function httpGet(url: string, timeout = 10): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "cortana-opportunity-engine/1.0" },
      signal: controller.signal,
    });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function extractXmlBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml))) {
    out.push(match[1]);
  }
  return out;
}

function extractTagText(block: string, tag: string): string | null {
  const tagPattern = tag.includes(":") ? tag.replace(":", "\\:") : `(?:\\w+:)?${tag}`;
  const re = new RegExp(`<${tagPattern}[^>]*>([\\s\\S]*?)</${tagPattern}>`, "i");
  const m = block.match(re);
  if (!m) return null;
  return m[1];
}

function extractLink(block: string): string {
  const text = extractTagText(block, "link");
  if (text && text.trim()) return text.trim();
  const m = block.match(/<(?:\w+:)?link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (m) return m[1];
  return "";
}

async function fetchGithubTrending(language = "typescript"): Promise<Array<Record<string, string>>> {
  const url = `https://github.com/trending/${encodeURIComponent(language)}?since=weekly`;
  const html = await httpGet(url);
  const re = /<h2 class="h3 lh-condensed">\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const out: Array<Record<string, string>> = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) && out.length < 12) {
    const href = match[1];
    const rawTitle = match[2];
    const title = rawTitle.replace(/\s+/g, "").replace("/", " / ").trim();
    out.push({ title, url: `https://github.com${href.trim()}`, summary: "Trending repository" });
  }
  return out;
}

async function parseFeed(feedUrl: string, limit = 8): Promise<Array<Record<string, string>>> {
  const xml = await httpGet(feedUrl);
  let items = extractXmlBlocks(xml, "item");
  if (!items.length) items = extractXmlBlocks(xml, "entry");

  const out: Array<Record<string, string>> = [];
  for (const it of items.slice(0, limit)) {
    const titleRaw = extractTagText(it, "title") ?? "";
    const link = extractLink(it);
    let summaryRaw = extractTagText(it, "description") ?? extractTagText(it, "summary") ?? "";
    if (!summaryRaw) summaryRaw = extractTagText(it, "content:encoded") ?? "";
    summaryRaw = stripHtml(summaryRaw);

    const title = normalizeWhitespace(titleRaw);
    const summary = normalizeWhitespace(summaryRaw).slice(0, 420);
    if (title) {
      out.push({ title, url: link, summary });
    }
  }
  return out;
}

function extractTags(text: string): string[] {
  const t = text.toLowerCase();
  const tags = STACK_KEYWORDS.filter((k) => t.includes(k));
  if (t.includes("oauth")) tags.push("oauth");
  if (t.includes("zero trust")) tags.push("zero-trust");
  return Array.from(new Set(tags)).sort();
}

function goalAlignment(tags: string[], text: string): Record<string, number> {
  const t = text.toLowerCase();
  const out: Record<string, number> = {};
  for (const [goal, words] of Object.entries(GOALS)) {
    const hits = words.filter((w) => t.includes(w) || tags.includes(w)).length;
    const denom = Math.max(2, words.length * 0.45);
    out[goal] = Math.round(Math.min(1.0, hits / denom) * 1000) / 1000;
  }
  return out;
}

function scoreRoiEffort(
  tags: string[],
  align: Record<string, number>,
  text: string,
): [number, number, number] {
  const alignTotal = Object.values(align).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(align).length);
  const stackFit = Math.min(1.0, tags.length / 4);
  const noveltyPenalty = /deep dive|book|long form/i.test(text) ? 0.08 : 0.0;

  const roi = Math.round(Math.min(0.98, 0.52 + 0.3 * alignTotal + 0.22 * stackFit) * 1000) / 1000;
  const effort = Math.round(Math.min(0.95, 0.3 + 0.4 * (1 - stackFit) + noveltyPenalty) * 1000) / 1000;
  const confidence = Math.round(
    Math.min(0.98, 0.55 + 0.28 * alignTotal + 0.17 * stackFit - 0.06 * noveltyPenalty) * 1000,
  ) / 1000;

  return [roi, effort, confidence];
}

function buildPlan(title: string, tags: string[]): string[] {
  const focus = tags.length ? tags.slice(0, 4).join(", ") : "relevant stack";
  return [
    `Read and summarize '${title}' in 10 bullets with emphasis on ${focus}.`,
    "Extract one reusable pattern for Resilience role deliverables this week.",
    "Implement a tiny proof-of-concept (60-90 min) in a side project repo.",
    "Publish internal notes: problem, pattern, implementation, tradeoffs.",
    "Create one follow-up task to productionize if signal quality remains high.",
  ];
}

function chooseMove(candidates: Opportunity[]): Opportunity | null {
  if (!candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => {
    const scoreA = a.roi - a.effort;
    const scoreB = b.roi - b.effort;
    if (scoreA !== scoreB) return scoreB - scoreA;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    const sumA = Object.values(a.goal_match).reduce((x, y) => x + y, 0);
    const sumB = Object.values(b.goal_match).reduce((x, y) => x + y, 0);
    return sumB - sumA;
  });
  return sorted[0];
}

function parseArgs(argv: string[]) {
  const args = {
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--json") {
      args.json = true;
    }
  }

  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const errors: string[] = [];
  const signals: Array<Record<string, string>> = [];

  for (const lang of ["typescript", "go"]) {
    try {
      const trending = await fetchGithubTrending(lang);
      signals.push(...trending);
    } catch (err) {
      errors.push(`trending ${lang}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const feed of FEEDS) {
    try {
      const items = await parseFeed(feed, 6);
      signals.push(...items);
    } catch (err) {
      errors.push(`feed ${feed}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const opportunities: Opportunity[] = [];
  for (const s of signals) {
    const text = `${s.title ?? ""} ${s.summary ?? ""}`;
    const tags = extractTags(text);
    if (!tags.length) continue;
    const align = goalAlignment(tags, text);
    const [roi, effort, confidence] = scoreRoiEffort(tags, align, text);
    opportunities.push({
      title: s.title ?? "Untitled",
      source: s.url ?? "signal",
      url: s.url ?? "",
      summary: s.summary ?? "",
      tags,
      goal_match: align,
      roi,
      effort,
      confidence,
      why_now: "Compounds stack relevance for role + masters while producing side-project artifacts.",
      execution_plan: buildPlan(s.title ?? "Untitled", tags),
    });
  }

  const move = chooseMove(opportunities);

  if (move) {
    logEvent(
      "career_opportunity",
      `Career move generated: ${move.title.slice(0, 120)}`,
      errors.length ? "warning" : "info",
      {
        confidence: move.confidence,
        roi: move.roi,
        effort: move.effort,
        errors: errors.slice(0, 6),
      },
      args.dryRun,
    );
  }

  const payload = {
    source: SOURCE,
    generated_at: new Date().toISOString(),
    signals_seen: signals.length,
    opportunities_scored: opportunities.length,
    career_move_of_the_week: move ?? null,
    errors,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    if (!move) {
      console.log("No qualifying opportunity found.");
    } else {
      console.log("Career Move of the Week");
      console.log(`- move: ${move.title}`);
      console.log(`- why now: ${move.why_now}`);
      console.log(`- roi/effort/confidence: ${move.roi}/${move.effort}/${move.confidence}`);
      console.log("- execution plan:");
      for (const step of move.execution_plan) {
        console.log(`  - ${step}`);
      }
    }
    if (errors.length) {
      console.log("- errors:");
      for (const e of errors.slice(0, 10)) {
        console.log(`  - ${e}`);
      }
    }
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
