#!/usr/bin/env npx tsx

import { runPsql } from "../lib/db.js";

const DB_NAME = "cortana";
const SOURCE = "mortgage_intel";

const SERIES: Record<string, string> = {
  MORTGAGE30US: "30Y fixed mortgage average",
  DGS10: "10Y Treasury yield",
};

const RSS_FEEDS = [
  "https://www.mba.org/rss/news-and-research-news.xml",
  "https://www.housingwire.com/feed/",
  "https://www.mortgagenewsdaily.com/rss",
  "https://www.nar.realtor/newsroom/rss",
];

const TOPIC_RULES: Record<string, string[]> = {
  rates: ["rate", "yield", "treasury", "fed", "inflation", "cpi", "mortgage pricing", "lock", "float"],
  regulation_compliance: [
    "cfpb",
    "fhfa",
    "hud",
    "fannie",
    "freddie",
    "compliance",
    "rule",
    "regulation",
    "lawsuit",
  ],
  underwriting_changes: ["underwriting", "du", "lp", "guideline", "ltv", "dti", "credit", "eligibility", "reserve"],
  regional_demand: [
    "inventory",
    "housing starts",
    "regional",
    "metro",
    "demand",
    "purchase volume",
    "refi",
    "application",
  ],
};

type IntelEvent = {
  title: string;
  source: string;
  url: string;
  published_at: string | null;
  summary: string;
  topic: string;
  urgency: number;
  lock_float: string;
  pipeline_effect: string;
  impact_score: number;
  what_changed: string;
  what_to_do: string;
  metadata: Record<string, any>;
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
  if (proc.status !== 0) throw new Error((proc.stderr || "").trim() || "psql failed");
  return (proc.stdout || "").trim();
}

function logEvent(message: string, severity: string, metadata: Record<string, any>, dryRun: boolean): void {
  if (dryRun) return;
  const sql =
    "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES " +
    `('mortgage_intel','${SOURCE}','${sqlEscape(severity)}','${sqlEscape(message)}','${sqlEscape(
      JSON.stringify(metadata),
    )}'::jsonb);`;
  runPsqlText(sql);
}

async function httpGet(url: string, timeout = 10): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "cortana-mortgage-intel/1.0" },
      signal: controller.signal,
    });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFredSeries(seriesId: string): Promise<Record<string, any>> {
  const apiKey = (process.env.FRED_API_KEY ?? "").trim();
  if (apiKey) {
    const qs = new URLSearchParams({
      series_id: seriesId,
      api_key: apiKey,
      file_type: "json",
      sort_order: "desc",
      limit: "5",
    });
    const url = `https://api.stlouisfed.org/fred/series/observations?${qs.toString()}`;
    const payload = JSON.parse(await httpGet(url));
    const obs = Array.isArray(payload.observations) ? payload.observations : [];
    const points = obs.filter((o) => o?.value !== null && o?.value !== ".").slice(0, 2);
    if (!points.length) throw new Error(`No observations for ${seriesId}`);
    const latest = points[0];
    const prior = points[1] ?? points[0];
    return {
      series_id: seriesId,
      latest_date: latest.date,
      latest_value: Number.parseFloat(latest.value),
      prior_value: Number.parseFloat(prior.value),
    };
  }

  const csvUrl = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const rows = (await httpGet(csvUrl))
    .split(/\r?\n/)
    .filter((r) => r && !r.endsWith(",."));
  if (rows.length < 3) throw new Error(`Insufficient CSV rows for ${seriesId}`);
  const latestRow = rows[rows.length - 1].split(",");
  const priorRow = rows[rows.length - 2].split(",");
  return {
    series_id: seriesId,
    latest_date: latestRow[0],
    latest_value: Number.parseFloat(latestRow[1]),
    prior_value: Number.parseFloat(priorRow[1]),
  };
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
  while ((match = re.exec(xml))) out.push(match[1]);
  return out;
}

function extractTagText(block: string, tag: string): string | null {
  const tagPattern = tag.includes(":") ? tag.replace(":", "\\:") : `(?:\\w+:)?${tag}`;
  const re = new RegExp(`<${tagPattern}[^>]*>([\\s\\S]*?)</${tagPattern}>`, "i");
  const m = block.match(re);
  return m ? m[1] : null;
}

function extractLink(block: string): string {
  const text = extractTagText(block, "link");
  if (text && text.trim()) return text.trim();
  const m = block.match(/<(?:\w+:)?link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (m) return m[1];
  return "";
}

async function fetchRssItems(limitPerFeed = 8): Promise<Array<Record<string, any>>> {
  const out: Array<Record<string, any>> = [];
  for (const feed of RSS_FEEDS) {
    try {
      const xmlTxt = await httpGet(feed);
      let items = extractXmlBlocks(xmlTxt, "item");
      if (!items.length) items = extractXmlBlocks(xmlTxt, "entry");
      for (const item of items.slice(0, limitPerFeed)) {
        const titleRaw = extractTagText(item, "title") ?? "";
        const link = extractLink(item);
        let desc =
          extractTagText(item, "description") ??
          extractTagText(item, "content:encoded") ??
          "";
        const pub =
          extractTagText(item, "pubDate") ??
          extractTagText(item, "updated") ??
          extractTagText(item, "published") ??
          null;
        if (titleRaw) {
          out.push({
            feed,
            title: normalizeWhitespace(titleRaw),
            link,
            summary: normalizeWhitespace(stripHtml(desc)).slice(0, 420),
            published_at: pub,
          });
        }
      }
    } catch {
      continue;
    }
  }
  return out;
}

function containsKeyword(text: string, keyword: string): boolean {
  const re = new RegExp(`\\b${keyword.toLowerCase().replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\b`, "i");
  return re.test(text.toLowerCase());
}

function isMortgageRelevant(text: string): boolean {
  const anchors = [
    "mortgage",
    "housing",
    "loan",
    "lending",
    "borrower",
    "refi",
    "purchase",
    "fannie",
    "freddie",
    "rate",
    "underwriting",
    "listing",
    "realtor",
    "real estate",
    "home sales",
    "inventory",
  ];
  return anchors.some((a) => containsKeyword(text, a));
}

function classifyTopic(text: string): string {
  let bestTopic = "regional_demand";
  let bestScore = 0;
  for (const [topic, keywords] of Object.entries(TOPIC_RULES)) {
    const score = keywords.filter((k) => containsKeyword(text, k)).length;
    if (score > bestScore) {
      bestTopic = topic;
      bestScore = score;
    }
  }
  return bestTopic;
}

function scoreImpact(topic: string, text: string, rateShiftBp: number): [number, string, string, number] {
  const t = text.toLowerCase();
  let urgency = 2;
  if (["immediate", "effective", "urgent", "breaking"].some((w) => t.includes(w))) urgency = 1;
  else if (["guidance", "proposal", "comment period"].some((w) => t.includes(w))) urgency = 3;

  let lockFloat = "monitor";
  if (topic === "rates") {
    if (rateShiftBp >= 7) {
      lockFloat = "bias_lock";
      urgency = Math.min(urgency, 1);
    } else if (rateShiftBp <= -7) {
      lockFloat = "bias_float_selective";
    }
  }

  const pipelineEffect: Record<string, string> = {
    rates: "pricing_volatility",
    regulation_compliance: "process_and_disclosure_updates",
    underwriting_changes: "eligibility_mix_shift",
    regional_demand: "lead_flow_and_conversion_shift",
  };

  let base = { rates: 0.78, regulation_compliance: 0.72, underwriting_changes: 0.69, regional_demand: 0.62 }[topic] ?? 0.6;
  if (urgency === 1) base += 0.12;
  else if (urgency === 2) base += 0.05;
  base += Math.min(Math.abs(rateShiftBp) / 100.0, 0.08);

  return [urgency, lockFloat, pipelineEffect[topic] ?? "monitor", Math.round(Math.min(base, 0.98) * 1000) / 1000];
}

function advisoryFor(item: Record<string, any>, rates: Record<string, any>): IntelEvent {
  const title = String(item.title ?? "");
  const summary = String(item.summary ?? "");
  const text = `${title} ${summary}`;
  const topic = classifyTopic(text);

  const mort = rates.MORTGAGE30US;
  const dgs10 = rates.DGS10;
  const mortShiftBp = (mort.latest_value - mort.prior_value) * 100;
  const tsyShiftBp = (dgs10.latest_value - dgs10.prior_value) * 100;

  const [urgency, lockFloat, pipelineEffect, impactScore] = scoreImpact(topic, text, mortShiftBp);

  const macroBlurb = `30Y mortgage ${mort.latest_value.toFixed(2)}% (${mortShiftBp >= 0 ? "+" : ""}${mortShiftBp.toFixed(
    1,
  )} bps) | 10Y treasury ${dgs10.latest_value.toFixed(2)}% (${tsyShiftBp >= 0 ? "+" : ""}${tsyShiftBp.toFixed(1)} bps)`;

  const whatChanged = `${title}. Macro tape: ${macroBlurb}.`;

  const actionMap: Record<string, string> = {
    rates: "Prioritize same-day lock/float calls for active borrowers; send concise rate-change update to hot pipeline clients.",
    regulation_compliance: "Review disclosure/process impacts and align scripts/checklists before next borrower touchpoint.",
    underwriting_changes: "Re-screen active files against guideline changes and flag borderline borrowers for re-structuring.",
    regional_demand: "Adjust outreach by market segment; focus lead-gen where demand velocity is improving.",
  };

  return {
    title,
    source: String(item.feed ?? "rss"),
    url: String(item.link ?? ""),
    published_at: item.published_at ?? null,
    summary,
    topic,
    urgency,
    lock_float: lockFloat,
    pipeline_effect: pipelineEffect,
    impact_score: impactScore,
    what_changed: whatChanged,
    what_to_do: actionMap[topic] ?? "Monitor for downstream borrower impact and prep comms as needed.",
    metadata: { macro: { mortgage30: mort, dgs10 }, topic, pipeline_effect: pipelineEffect },
  };
}

function parseArgs(argv: string[]) {
  const args = {
    maxItems: 8,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--max-items") args.maxItems = Number.parseInt(argv[++i] ?? "8", 10);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--json") args.json = true;
  }

  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date().toISOString();

  const rates: Record<string, any> = {};
  const errors: string[] = [];
  for (const sid of Object.keys(SERIES)) {
    try {
      rates[sid] = await fetchFredSeries(sid);
    } catch (err) {
      errors.push(`FRED ${sid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const feedItems = await fetchRssItems(8);
  const advisories: IntelEvent[] = [];

  if (rates.MORTGAGE30US && rates.DGS10) {
    for (const item of feedItems) {
      if (!isMortgageRelevant(`${item.title ?? ""} ${item.summary ?? ""}`)) continue;
      try {
        advisories.push(advisoryFor(item, rates));
      } catch (err) {
        errors.push(`advisory ${(item.title ?? "?").slice(0, 30)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (!advisories.length && rates.MORTGAGE30US && rates.DGS10) {
    const mort = rates.MORTGAGE30US;
    const dgs10 = rates.DGS10;
    const mortShiftBp = (mort.latest_value - mort.prior_value) * 100;
    const tsyShiftBp = (dgs10.latest_value - dgs10.prior_value) * 100;
    const urgency = Math.abs(mortShiftBp) >= 7 ? 1 : 2;
    const lockFloat = mortShiftBp >= 7 ? "bias_lock" : mortShiftBp <= -7 ? "bias_float_selective" : "monitor";
    advisories.push({
      title: "Daily macro rate snapshot",
      source: "FRED",
      url: "https://fred.stlouisfed.org/",
      published_at: null,
      summary: "Macro-only fallback when RSS signals are thin.",
      topic: "rates",
      urgency,
      lock_float: lockFloat,
      pipeline_effect: "pricing_volatility",
      impact_score: Math.round(Math.min(0.94, 0.74 + Math.abs(mortShiftBp) / 80.0) * 1000) / 1000,
      what_changed: `30Y mortgage ${mort.latest_value.toFixed(2)}% (${mortShiftBp >= 0 ? "+" : ""}${mortShiftBp.toFixed(
        1,
      )} bps) and 10Y treasury ${dgs10.latest_value.toFixed(2)}% (${tsyShiftBp >= 0 ? "+" : ""}${tsyShiftBp.toFixed(1)} bps).`,
      what_to_do: "Send lock/float guidance to active pipeline and prioritize borrowers near commitment deadlines.",
      metadata: { macro: { mortgage30: mort, dgs10 }, fallback: true },
    });
  }

  advisories.sort((a, b) => {
    if (a.urgency !== b.urgency) return a.urgency - b.urgency;
    return b.impact_score - a.impact_score;
  });
  const maxItems = Math.max(1, args.maxItems);
  const finalAdvisories = advisories.slice(0, maxItems);

  if (!args.dryRun) {
    logEvent(
      `Mortgage intel run completed: ${finalAdvisories.length} advisories`,
      errors.length ? "warning" : "info",
      { advisories: finalAdvisories.length, errors: errors.slice(0, 8) },
      false,
    );
  }

  const payload = {
    source: SOURCE,
    generated_at: now,
    series: rates,
    advisories: finalAdvisories,
    errors,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  console.log("Mortgage Intel — what changed / what to do");
  finalAdvisories.forEach((a, idx) => {
    console.log(`\n${idx + 1}. [${a.topic}] ${a.title}`);
    console.log(`   what changed: ${a.what_changed}`);
    console.log(`   what to do:   ${a.what_to_do}`);
    console.log(
      `   impact: urgency=${a.urgency} lock/float=${a.lock_float} pipeline=${a.pipeline_effect} score=${a.impact_score}`,
    );
  });
  if (errors.length) {
    console.log("\nErrors:");
    for (const e of errors.slice(0, 12)) {
      console.log(`- ${e}`);
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
