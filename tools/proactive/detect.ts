#!/usr/bin/env npx tsx

import { spawnSync } from "child_process";
import http from "http";
import https from "https";
import { URL } from "url";
import { query } from "../lib/db.js";
import { fetchAlpacaPortfolioDiagnostics } from "./alpaca-heartbeat.js";
const ET_TZ = "America/New_York";

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "your", "have", "will", "you", "about", "re", "fw", "fwd",
  "meeting", "call", "sync", "update", "project", "team", "today", "tomorrow", "regarding", "subject",
]);

const SECTOR_ETFS: Record<string, string> = {
  Technology: "XLK",
  "Financial Services": "XLF",
  Healthcare: "XLV",
  "Consumer Cyclical": "XLY",
  "Consumer Defensive": "XLP",
  Energy: "XLE",
  Industrials: "XLI",
  Utilities: "XLU",
  "Real Estate": "XLRE",
  "Basic Materials": "XLB",
  "Communication Services": "XLC",
};

type SignalParams = {
  source: string;
  signal_type: string;
  title: string;
  summary: string;
  confidence: number;
  severity?: string;
  opportunity?: boolean;
  starts_at?: string | null;
  metadata?: Record<string, unknown> | null;
};

class Signal {
  source: string;
  signal_type: string;
  title: string;
  summary: string;
  confidence: number;
  severity: string;
  opportunity: boolean;
  starts_at: string | null;
  metadata: Record<string, unknown> | null;

  constructor(params: SignalParams) {
    this.source = params.source;
    this.signal_type = params.signal_type;
    this.title = params.title;
    this.summary = params.summary;
    this.confidence = params.confidence;
    this.severity = params.severity ?? "medium";
    this.opportunity = params.opportunity ?? true;
    this.starts_at = params.starts_at ?? null;
    this.metadata = params.metadata ?? null;
  }

  fingerprint(): string {
    const key = `${this.source}|${this.signal_type}|${this.title}|${this.starts_at ?? ""}`;
    return key.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 300);
  }
}

function sqlEscape(text: string): string {
  return text.replace(/'/g, "''");
}

function runPsql(sql: string): string {
  return query(sql).trim();
}

function fetchJsonFromSql(sql: string): Array<Record<string, unknown>> {
  const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (${sql}) t;`;
  const raw = runPsql(wrapped);
  if (!raw) return [];
  return JSON.parse(raw) as Array<Record<string, unknown>>;
}

function httpRequest(url: string, timeout = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request(
      parsed,
      { headers: { "User-Agent": "cortana-proactive-detector/1.0" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolve(body);
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeout, () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}

async function httpJson(url: string, timeout = 8000): Promise<unknown> {
  const text = await httpRequest(url, timeout);
  return JSON.parse(text);
}

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function getEtParts(date: Date): ZonedParts {
  const parts = ET_PARTS.formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    lookup[part.type] = part.value;
  }
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
  };
}

function getEtOffsetMinutes(date: Date): number {
  const parts = getEtParts(date);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, "0");
  const minutes = String(abs % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}

function toEtISOString(date: Date): string {
  const parts = getEtParts(date);
  const ms = date.getMilliseconds();
  const frac = ms ? `.${String(ms).padStart(3, "0")}` : "";
  const offset = formatOffset(getEtOffsetMinutes(date));
  return (
    `${String(parts.year).padStart(4, "0")}-` +
    `${String(parts.month).padStart(2, "0")}-` +
    `${String(parts.day).padStart(2, "0")}T` +
    `${String(parts.hour).padStart(2, "0")}:` +
    `${String(parts.minute).padStart(2, "0")}:` +
    `${String(parts.second).padStart(2, "0")}` +
    `${frac}${offset}`
  );
}

function formatEtDate(date: Date): string {
  const parts = getEtParts(date);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function makeEtDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
  const offsetMinutes = getEtOffsetMinutes(utcGuess);
  return new Date(utcGuess.getTime() - offsetMinutes * 60000);
}

function parseDt(value: string | null | undefined): Date | null {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;

  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    return makeEtDate(year, month, day);
  }

  if (/^\d+$/.test(text)) return null;

  if (text.endsWith("Z")) {
    const d = new Date(text.replace("Z", "+00:00"));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(text);
  if (!Number.isNaN(d.getTime())) return d;

  const prefix = text.slice(0, 10);
  const prefixMatch = prefix.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (prefixMatch) {
    const year = Number(prefixMatch[1]);
    const month = Number(prefixMatch[2]);
    const day = Number(prefixMatch[3]);
    return makeEtDate(year, month, day);
  }

  return null;
}

function gogJson(args: string[]): Array<Record<string, unknown>> {
  const cmd = ["gog", "--account", process.env.GOG_ACCOUNT ?? "hameldesai3@gmail.com", ...args, "--json"];
  const proc = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (proc.status !== 0 || !(proc.stdout || "").trim()) return [];
  try {
    const data = JSON.parse(proc.stdout || "");
    if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
    if (data && typeof data === "object") {
      return (data.events || data.messages || data.threads || []) as Array<Record<string, unknown>>;
    }
  } catch {
    return [];
  }
  return [];
}

function tokenize(text: string): Set<string> {
  const toks = Array.from(text.toLowerCase().matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)).map((m) => m[0]);
  return new Set(toks.filter((t) => !STOPWORDS.has(t)));
}

function weekdayIndexEt(now: Date): number {
  const parts = getEtParts(now);
  const dow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return dow === 0 ? 6 : dow - 1;
}

async function collectCalendar(now: Date): Promise<Signal[]> {
  const calId = process.env.PROACTIVE_CALENDAR_ID ?? "primary";
  const toDt = formatEtDate(new Date(now.getTime() + 48 * 60 * 60 * 1000));
  const events = gogJson(["calendar", "events", calId, "--from", "today", "--to", toDt]);

  const parsed: Array<Record<string, any>> = [];
  for (const ev of events) {
    const startVal =
      (typeof ev.start === "object" && ev.start ? (ev.start as any).dateTime : null) ||
      (typeof ev.start === "object" && ev.start ? (ev.start as any).date : null) ||
      ev.start;
    const endVal =
      (typeof ev.end === "object" && ev.end ? (ev.end as any).dateTime : null) ||
      (typeof ev.end === "object" && ev.end ? (ev.end as any).date : null) ||
      ev.end;

    const start = parseDt(startVal as string);
    const end = parseDt(endVal as string);
    if (!start) continue;
    const windowStart = now.getTime();
    const windowEnd = now.getTime() + 48 * 60 * 60 * 1000;
    if (start.getTime() < windowStart || start.getTime() > windowEnd) continue;

    parsed.push({
      id: ev.id ?? "",
      title: ev.summary ?? "Untitled",
      start,
      end: end ?? new Date(start.getTime() + 60 * 60 * 1000),
      location: ev.location ?? "",
      desc: ev.description ?? "",
    });
  }

  parsed.sort((a, b) => a.start.getTime() - b.start.getTime());

  const signals: Signal[] = [];

  for (let i = 0; i < parsed.length; i += 1) {
    const ev = parsed[i];
    const mins = Math.floor((ev.start.getTime() - now.getTime()) / 60000);
    const title = ev.title;

    const prepHints = ["interview", "client", "demo", "review", "presentation", "deadline"].some((k) =>
      `${title} ${ev.desc}`.toLowerCase().includes(k)
    );

    if (mins <= 180 && prepHints) {
      const conf = 0.70 + (mins <= 90 ? 0.10 : 0);
      signals.push(
        new Signal({
          source: "calendar",
          signal_type: "prep_needed",
          title: `Prep window closing: ${title}`,
          summary: `${title} starts in ${mins}m. Recommend prep checklist now.`,
          confidence: Math.min(conf, 0.95),
          severity: mins <= 90 ? "high" : "medium",
          opportunity: false,
          starts_at: toEtISOString(ev.start),
          metadata: { event_id: ev.id, minutes_until: mins },
        })
      );
    }

    if (ev.location && mins <= 120) {
      signals.push(
        new Signal({
          source: "calendar",
          signal_type: "travel_buffer",
          title: `Travel buffer: ${title}`,
          summary: `${title} has location '${ev.location}' and starts in ${mins}m.`,
          confidence: mins > 60 ? 0.67 : 0.77,
          severity: "medium",
          opportunity: false,
          starts_at: toEtISOString(ev.start),
          metadata: { event_id: ev.id, location: ev.location },
        })
      );
    }

    if (i < parsed.length - 1) {
      const nxt = parsed[i + 1];
      const gap = Math.floor((nxt.start.getTime() - ev.end.getTime()) / 60000);
      if (gap < 10) {
        signals.push(
          new Signal({
            source: "calendar",
            signal_type: "conflict_or_tight_transition",
            title: `Tight calendar transition: ${title} → ${nxt.title}`,
            summary: `Only ${gap}m between events. High context-switch risk.`,
            confidence: gap <= 0 ? 0.78 : 0.69,
            severity: gap <= 0 ? "high" : "medium",
            opportunity: false,
            starts_at: toEtISOString(ev.start),
            metadata: { event_a: ev.id, event_b: nxt.id, gap_minutes: gap },
          })
        );
      }
    }
  }

  return signals;
}

async function collectPortfolio(now: Date): Promise<Signal[]> {
  const signals: Signal[] = [];
  const diagnostic = await fetchAlpacaPortfolioDiagnostics();
  if (!diagnostic.ok) {
    signals.push(
      new Signal({
        source: "portfolio",
        signal_type: `alpaca_${diagnostic.kind ?? "failure"}`,
        title: diagnostic.title ?? "Alpaca portfolio path failed",
        summary: diagnostic.summary ?? "Portfolio heartbeat could not read the Alpaca service path.",
        confidence: 0.93,
        severity: diagnostic.kind === "target_mismatch" || diagnostic.kind === "service_unhealthy" ? "high" : "medium",
        opportunity: false,
        metadata: diagnostic.metadata ?? null,
      })
    );
    return signals;
  }

  const port = diagnostic.portfolio;
  const positions = port && typeof port === "object" ? port.positions ?? [] : [];
  const symbols = positions.map((p: any) => p.symbol).filter((s: any) => s);
  if (!symbols.length) return signals;

  const qurl = "https://query1.finance.yahoo.com/v7/finance/quote?" + new URLSearchParams({ symbols: symbols.join(",") }).toString();
  let rows: any[] = [];
  try {
    const quoteData = await httpJson(qurl);
    rows = ((quoteData as any).quoteResponse || {}).result || [];
  } catch {
    rows = [];
  }

  for (const r of rows) {
    const sym = r.symbol;
    const vol = r.regularMarketVolume || 0;
    const avg = r.averageDailyVolume3Month || 0;
    if (sym && avg && vol) {
      const ratio = vol / avg;
      if (ratio >= 1.8) {
        signals.push(
          new Signal({
            source: "portfolio",
            signal_type: "unusual_volume",
            title: `${sym} unusual volume (${ratio.toFixed(1)}x)`,
            summary: `${sym} trading volume is ${ratio.toFixed(1)}x 3M average.`,
            confidence: Math.min(0.60 + Math.min((ratio - 1.8) * 0.08, 0.25), 0.92),
            severity: ratio < 2.5 ? "medium" : "high",
            opportunity: (r.regularMarketChangePercent || 0) > 0,
            metadata: { symbol: sym, vol_ratio: Math.round(ratio * 100) / 100 },
          })
        );
      }
    }
  }

  const heldSectors: Record<string, string[]> = {};
  for (const sym of symbols.slice(0, 15)) {
    try {
      const esUrl = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=calendarEvents,assetProfile`;
      const js = await httpJson(esUrl);
      const result = (((js as any).quoteSummary || {}).result || [{}])[0];
      const ce = ((result || {}).calendarEvents || {}).earnings || {};
      const dates = ce.earningsDate || [];
      let nextEarn: Date | null = null;
      if (dates.length) {
        const maybe = dates[0];
        if (maybe && typeof maybe === "object") {
          nextEarn = parseDt((maybe as any).fmt || (maybe as any).raw || null);
        }
      }
      if (nextEarn && nextEarn.getTime() >= now.getTime() && nextEarn.getTime() <= now.getTime() + 48 * 60 * 60 * 1000) {
        const hrs = Math.floor((nextEarn.getTime() - now.getTime()) / 3600000);
        signals.push(
          new Signal({
            source: "portfolio",
            signal_type: "earnings_within_48h",
            title: `${sym} earnings in ${hrs}h`,
            summary: `Held position ${sym} has earnings within 48h.`,
            confidence: 0.86,
            severity: "high",
            opportunity: false,
            starts_at: toEtISOString(nextEarn),
            metadata: { symbol: sym, hours_until: hrs },
          })
        );
      }

      const sector = String(((result || {}).assetProfile || {}).sector || "").trim();
      if (sector) {
        heldSectors[sector] = heldSectors[sector] || [];
        heldSectors[sector].push(sym);
      }
    } catch {
      continue;
    }
  }

  const etfs = Object.entries(SECTOR_ETFS)
    .filter(([sector]) => Object.prototype.hasOwnProperty.call(heldSectors, sector))
    .map(([, etf]) => etf);

  if (etfs.length) {
    try {
      const sUrl = "https://query1.finance.yahoo.com/v7/finance/quote?" + new URLSearchParams({ symbols: etfs.join(",") }).toString();
      const sRows = (((await httpJson(sUrl) as any).quoteResponse || {}).result || []) as any[];
      const bySym: Record<string, number> = {};
      for (const r of sRows) {
        bySym[r.symbol] = r.regularMarketChangePercent || 0;
      }
      const sectorPerf: Record<string, number> = {};
      for (const [sector, etf] of Object.entries(SECTOR_ETFS)) {
        if (etf in bySym) sectorPerf[sector] = bySym[etf];
      }
      const perfEntries = Object.entries(sectorPerf);
      if (perfEntries.length) {
        const top = perfEntries.reduce((a, b) => (a[1] > b[1] ? a : b));
        for (const [sec, syms] of Object.entries(heldSectors)) {
          const ours = sectorPerf[sec];
          if (ours == null) continue;
          const spread = top[1] - ours;
          if (spread >= 1.2) {
            signals.push(
              new Signal({
                source: "portfolio",
                signal_type: "sector_rotation",
                title: `Sector lag signal: ${sec}`,
                summary: `Held sector ${sec} trails top sector ${top[0]} by ${spread.toFixed(2)}% today.`,
                confidence: Math.min(0.62 + Math.min(spread * 0.08, 0.25), 0.9),
                severity: "medium",
                opportunity: true,
                metadata: {
                  held_sector: sec,
                  held_symbols: syms,
                  top_sector: top[0],
                  spread_pct: Math.round(spread * 100) / 100,
                },
              })
            );
          }
        }
      }
    } catch {
      // ignore
    }
  }

  return signals;
}

async function collectEmail(now: Date): Promise<Signal[]> {
  const msgs = gogJson([
    "gmail",
    "search",
    process.env.PROACTIVE_EMAIL_QUERY ?? "is:unread newer_than:7d",
    "--max",
    process.env.PROACTIVE_EMAIL_MAX ?? "25",
  ]);

  const signals: Signal[] = [];
  const urgentWords = /\b(urgent|asap|immediately|deadline|final notice|action required|payment due|security alert)\b/i;
  const followupWords = /\b(follow\s?up|checking in|circling back|gentle reminder|nudge)\b/i;

  let urgentCount = 0;
  let oldUnread = 0;

  for (const m of msgs) {
    const subj = String(m.subject ?? "");
    const snippet = String(m.snippet ?? m.preview ?? "");
    const sender = String(m.from ?? m.sender ?? "Unknown");
    const text = `${subj} ${snippet}`;

    if (urgentWords.test(text)) {
      urgentCount += 1;
      signals.push(
        new Signal({
          source: "email",
          signal_type: "urgent_inbox_pattern",
          title: `Urgent email: ${subj.slice(0, 80)}`,
          summary: `Urgency language detected from ${sender}.`,
          confidence: 0.8,
          severity: "high",
          opportunity: false,
          metadata: { from: sender, subject: subj },
        })
      );
    }

    if (followupWords.test(text)) {
      signals.push(
        new Signal({
          source: "email",
          signal_type: "followup_needed",
          title: `Follow-up thread: ${subj.slice(0, 80)}`,
          summary: `Thread likely needs response/closure (${sender}).`,
          confidence: 0.71,
          severity: "medium",
          opportunity: false,
          metadata: { from: sender, subject: subj },
        })
      );
    }

    const d = parseDt(String(m.date ?? m.internalDate ?? ""));
    if (d && (now.getTime() - d.getTime()) > 30 * 60 * 60 * 1000) {
      oldUnread += 1;
    }
  }

  if (oldUnread >= 3) {
    signals.push(
      new Signal({
        source: "email",
        signal_type: "unanswered_backlog",
        title: `Inbox backlog risk (${oldUnread} stale unread)`,
        summary: "Unread threads older than ~30h may need triage block.",
        confidence: Math.min(0.58 + oldUnread * 0.05, 0.85),
        severity: "medium",
        opportunity: false,
        metadata: { stale_unread_count: oldUnread },
      })
    );
  }

  if (urgentCount >= 2) {
    signals.push(
      new Signal({
        source: "email",
        signal_type: "urgency_cluster",
        title: `Urgency cluster (${urgentCount} threads)`,
        summary: "Multiple urgent emails detected; recommend proactive response window.",
        confidence: Math.min(0.66 + urgentCount * 0.05, 0.9),
        severity: "high",
        opportunity: false,
        metadata: { urgent_count: urgentCount },
      })
    );
  }

  return signals;
}

async function collectBehavioral(now: Date): Promise<Signal[]> {
  const dow = weekdayIndexEt(now);
  const nowParts = getEtParts(now);
  const hour = nowParts.hour;
  const rows = fetchJsonFromSql(
    "SELECT pattern_type, value, day_of_week, metadata, COUNT(*)::int AS n " +
      "FROM cortana_patterns " +
      `WHERE day_of_week = ${dow} AND timestamp > NOW() - INTERVAL '120 days' ` +
      "GROUP BY pattern_type, value, day_of_week, metadata ORDER BY n DESC LIMIT 20"
  );

  const signals: Signal[] = [];
  for (const r of rows) {
    const ptype = r.pattern_type as string | undefined;
    const value = String(r.value ?? "");
    const n = Number(r.n ?? 0);

    const match = value.match(/^(\d{1,2}):(\d{2})$/);
    if (!match || !ptype) continue;

    const hourVal = Number(match[1]);
    const minVal = Number(match[2]);
    const target = makeEtDate(nowParts.year, nowParts.month, nowParts.day, hourVal, minVal, 0, 0);

    const deltaM = Math.abs(Math.floor((target.getTime() - now.getTime()) / 60000));
    if (deltaM <= 90 && ["wake", "sleep_check"].includes(ptype)) {
      const conf = Math.min(0.5 + n * 0.03, 0.88);
      signals.push(
        new Signal({
          source: "behavior",
          signal_type: "routine_prediction",
          title: `Expected ${ptype.replace("_", " ")} window`,
          summary: `Historical ${ptype} around ${value} on this weekday (n=${n}).`,
          confidence: conf,
          severity: "low",
          opportunity: true,
          starts_at: toEtISOString(target),
          metadata: { pattern_type: ptype, value, count: n, current_hour: hour },
        })
      );
    }
  }

  return signals;
}

function correlate(signals: Signal[]): Signal[] {
  const out: Signal[] = [];
  const calendar = signals.filter((s) => s.source === "calendar");
  const email = signals.filter((s) => s.source === "email");

  for (const c of calendar) {
    const cTokens = tokenize(`${c.title} ${c.summary}`);
    if (!cTokens.size) continue;
    for (const e of email) {
      const eTokens = tokenize(`${e.title} ${e.summary}`);
      const overlap = [...cTokens].filter((t) => eTokens.has(t));
      if (overlap.length >= 2) {
        const conf = Math.min(0.68 + 0.04 * overlap.length, 0.93);
        const sorted = overlap.sort();
        out.push(
          new Signal({
            source: "cross_signal",
            signal_type: "calendar_email_correlation",
            title: "Meeting prep likely needed from email context",
            summary: `Calendar + email overlap: ${sorted.slice(0, 5).join(", ")}`,
            confidence: conf,
            severity: conf >= 0.8 ? "high" : "medium",
            opportunity: false,
            metadata: {
              calendar_title: c.title,
              email_title: e.title,
              token_overlap: sorted.slice(0, 8),
            },
          })
        );
      }
    }
  }

  return out;
}

function persist(runId: number, signals: Signal[], minConf: number, createTasks: boolean): [number, number] {
  let inserted = 0;
  let suggested = 0;

  for (const s of signals) {
    if (s.confidence < minConf) continue;

    const fp = s.fingerprint();
    const meta = JSON.stringify(s.metadata ?? {});
    const sql =
      "INSERT INTO cortana_proactive_signals " +
      "(run_id, source, signal_type, title, summary, confidence, severity, opportunity, starts_at, fingerprint, metadata) VALUES " +
      `(${runId}, '${sqlEscape(s.source)}', '${sqlEscape(s.signal_type)}', '${sqlEscape(s.title)}', ` +
      `'${sqlEscape(s.summary)}', ${s.confidence.toFixed(3)}, '${sqlEscape(s.severity)}', ${s.opportunity ? "TRUE" : "FALSE"}, ` +
      `${s.starts_at ? `'${sqlEscape(s.starts_at)}'` : "NULL"}, '${sqlEscape(fp)}', '${sqlEscape(meta)}'::jsonb) ` +
      "ON CONFLICT (fingerprint) DO NOTHING RETURNING id;";

    const sid = runPsql(sql);
    if (!sid) continue;
    inserted += 1;

    const suggestion = `${s.title} — ${s.summary}`;
    runPsql(
      "INSERT INTO cortana_proactive_suggestions (source, suggestion, status, metadata) VALUES " +
        `('proactive-detector', '${sqlEscape(suggestion)}', 'ready', ` +
        `'${sqlEscape(JSON.stringify({ signal_id: Number(sid), confidence: s.confidence, signal_type: s.signal_type }))}'::jsonb);`
    );
    suggested += 1;

    if (createTasks && s.confidence >= 0.82) {
      const title = `Proactive: ${s.title}`;
      runPsql(
        "INSERT INTO cortana_tasks (source, title, description, priority, status, auto_executable, execution_plan, metadata) VALUES " +
          `('proactive-detector', '${sqlEscape(title)}', '${sqlEscape(s.summary)}', 2, 'ready', FALSE, ` +
          `'Review proactively surfaced risk/opportunity and act manually if needed.', ` +
          `'${sqlEscape(JSON.stringify({ signal_id: Number(sid), confidence: s.confidence, source: s.source }))}'::jsonb);`
      );
    }
  }

  return [inserted, suggested];
}

type Args = { minConfidence: number; createTasks: boolean; dryRun: boolean };

function parseArgs(argv: string[]): Args {
  let minConfidence = Number.parseFloat(process.env.PROACTIVE_MIN_CONFIDENCE ?? "0.66");
  let createTasks = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--min-confidence" && argv[i + 1]) {
      minConfidence = Number.parseFloat(argv[i + 1]);
      i += 1;
    } else if (arg === "--create-tasks") {
      createTasks = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return { minConfidence, createTasks, dryRun };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const now = new Date();
  const started = toEtISOString(now);

  const runId = Number(
    runPsql(
      "INSERT INTO cortana_proactive_detector_runs (status, started_at, metadata) VALUES ('running', NOW(), '{}'::jsonb) RETURNING id;"
    )
  );

  const allSignals: Signal[] = [];
  const errors: string[] = [];

  const collectors = [
    { name: "collect_calendar", fn: collectCalendar },
    { name: "collect_portfolio", fn: collectPortfolio },
    { name: "collect_email", fn: collectEmail },
    { name: "collect_behavioral", fn: collectBehavioral },
  ];

  for (const collector of collectors) {
    try {
      allSignals.push(...(await collector.fn(now)));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push(`${collector.name}: ${msg}`);
    }
  }

  allSignals.push(...correlate(allSignals));
  allSignals.sort((a, b) => b.confidence - a.confidence);

  if (args.dryRun) {
    console.log(
      JSON.stringify(
        {
          run_id: runId,
          started,
          min_confidence: args.minConfidence,
          signals: allSignals
            .filter((s) => s.confidence >= args.minConfidence)
            .map((s) => ({ ...s })),
          errors,
        },
        null,
        2
      )
    );
    runPsql(
      "UPDATE cortana_proactive_detector_runs SET status='completed', finished_at=NOW(), " +
        `signals_total=${allSignals.length}, signals_gated=${allSignals.filter((s) => s.confidence >= args.minConfidence).length}, ` +
        `errors='${sqlEscape(JSON.stringify(errors))}'::jsonb WHERE id=${runId};`
    );
    return 0;
  }

  const [inserted, suggested] = persist(runId, allSignals, args.minConfidence, args.createTasks);
  runPsql(
    "UPDATE cortana_proactive_detector_runs SET status='completed', finished_at=NOW(), " +
      `signals_total=${allSignals.length}, signals_gated=${inserted}, suggestions_created=${suggested}, ` +
      `errors='${sqlEscape(JSON.stringify(errors))}'::jsonb WHERE id=${runId};`
  );

  console.log(
    JSON.stringify(
      {
        run_id: runId,
        signals_total: allSignals.length,
        signals_persisted: inserted,
        suggestions_created: suggested,
        min_confidence: args.minConfidence,
        errors,
      },
      null,
      2
    )
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(msg);
    process.exit(1);
  });
