#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { query } from "../lib/db.js";
const calendarId = "Clawdbot-Calendar";
const toDate = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
const keywords = ["review", "presentation", "demo", "interview"];
const oneOnOne = /\b(1:1|1-1|one on one|one-on-one)\b/i;

function run(cmd: string[], okFail = false): string {
  const p = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (p.status !== 0 && !okFail) throw new Error(p.stderr.trim() || `Command failed: ${cmd.join(" ")}`);
  return p.stdout || "";
}

function parseIso(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function eventStartEnd(ev: any): { start: Date | null; end: Date | null; allDay: boolean } {
  const s = ev.start ?? {};
  const e = ev.end ?? {};
  if (s.dateTime) return { start: parseIso(s.dateTime), end: parseIso(e.dateTime), allDay: false };
  const ds = s.date;
  const de = e.date;
  return {
    start: ds ? parseIso(`${ds}T00:00:00Z`) : null,
    end: de ? parseIso(`${de}T00:00:00Z`) : null,
    allDay: true,
  };
}

function hasExternalAttendees(ev: any): boolean {
  const attendees = ev.attendees ?? [];
  if (!Array.isArray(attendees) || attendees.length === 0) return false;

  const organizer = String(ev.organizer?.email ?? "").toLowerCase();
  const creator = String(ev.creator?.email ?? "").toLowerCase();
  const known = new Set([organizer, creator, "hameldesai3@gmail.com"]);

  for (const a of attendees) {
    const email = String(a?.email ?? "").toLowerCase();
    if (!email || known.has(email) || email.endsWith("@group.calendar.google.com")) continue;
    return true;
  }
  return false;
}

function formatDelta(target: Date | null): string {
  if (!target) return "unknown";
  const secs = Math.floor((target.getTime() - Date.now()) / 1000);
  if (secs <= 0) return "started/already passed";
  const hours = Math.floor(secs / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h ${mins}m`;
  return `${hours}h ${mins}m`;
}

function buildActions(reasons: string[], lowPriority: boolean): string[] {
  const actions: string[] = [];
  if (reasons.some((r) => r.includes("external attendees"))) actions.push("Review attendee context and company background", "Prepare a tight agenda and expected outcomes");
  if (reasons.some((r) => r.includes("keyword"))) actions.push("Review supporting docs/slides and key decisions", "Draft talking points and likely Q&A");
  if (reasons.some((r) => r.includes("1:1"))) actions.push("Skim last 1:1 notes", "Add 1-2 priorities or blockers to discuss");
  if (!actions.length) actions.push("Quick pre-read: objective, risks, and decisions needed");
  const dedup = [...new Set(actions)];
  if (lowPriority) dedup.push("Keep prep light: 5-10 minutes max");
  return dedup;
}

function main(): number {
  const raw = run(["gog", "cal", "list", calendarId, "--from", "today", "--to", toDate, "--plain"]);
  const lines = raw.split("\n").filter((l) => l.trim());
  if (!lines.length) {
    console.log(JSON.stringify({ generated_at: new Date().toISOString(), calendar: calendarId, range: { from: "today", to: toDate }, totals: { events_seen: 0, all_day_skipped: 0, flagged: 0 }, flagged_events: [], summary: "Flagged 0 of 0 events (0 all-day skipped)." }, null, 2));
    return 0;
  }

  const headers = lines[0].split("\t");
  const rows = lines.slice(1).map((line) => {
    const vals = line.split("\t");
    const o: Record<string, string> = {};
    headers.forEach((h, i) => { o[h] = vals[i] ?? ""; });
    return o;
  });

  const report: any = {
    generated_at: new Date().toISOString(),
    calendar: calendarId,
    range: { from: "today", to: toDate },
    totals: { events_seen: 0, all_day_skipped: 0, flagged: 0 },
    flagged_events: [],
    summary: "",
  };

  for (const row of rows) {
    const eventId = (row.ID ?? "").trim();
    if (!eventId) continue;
    report.totals.events_seen += 1;

    let ev: any;
    try {
      ev = JSON.parse(run(["gog", "cal", "event", calendarId, eventId, "--json", "--results-only"]));
    } catch {
      ev = { id: eventId, summary: (row.SUMMARY ?? "").trim(), start: { dateTime: (row.START ?? "").trim() }, end: { dateTime: (row.END ?? "").trim() } };
    }

    const title = String(ev.summary ?? "(no title)").trim();
    const { start, end, allDay } = eventStartEnd(ev);
    if (allDay) {
      report.totals.all_day_skipped += 1;
      continue;
    }

    const reasons: string[] = [];
    let lowPriority = false;
    if (hasExternalAttendees(ev)) reasons.push("external attendees");

    const lower = title.toLowerCase();
    const hits = keywords.filter((k) => lower.includes(k));
    if (hits.length) reasons.push(`keyword in title: ${hits.join(", ")}`);

    const recurring = Boolean(ev.recurringEventId || ev.recurrence);
    if (recurring && oneOnOne.test(title)) {
      reasons.push("recurring 1:1");
      lowPriority = true;
    }

    if (!reasons.length) continue;

    report.totals.flagged += 1;
    report.flagged_events.push({
      id: ev.id ?? eventId,
      title,
      start: start?.toISOString() ?? null,
      end: end?.toISOString() ?? null,
      time_until: formatDelta(start),
      priority: lowPriority ? "low" : "normal",
      reasons,
      prep_actions: buildActions(reasons, lowPriority),
      html_link: ev.htmlLink,
    });
  }

  const { flagged, events_seen: seen, all_day_skipped: skipped } = report.totals;
  report.summary = `Flagged ${flagged} of ${seen} events (${skipped} all-day skipped).`;

  console.log(JSON.stringify(report, null, 2));
  console.log("\n--- SUMMARY ---");
  console.log(report.summary);

  if (flagged) {
    report.flagged_events.forEach((e: any, idx: number) => {
      console.log(`${idx + 1}. [${e.priority}] ${e.title} (${e.time_until})`);
      console.log(`   Reasons: ${e.reasons.join(", ")}`);
      console.log(`   Prep: ${e.prep_actions.join("; ")}`);
    });
  }

  try {
    const metadata = {
      calendar: calendarId, range_to: toDate, events_seen: seen, all_day_skipped: skipped, flagged,
      flagged_titles: report.flagged_events.map((e: any) => e.title),
    };
    const msg = report.summary.replace(/'/g, "''");
    const meta = JSON.stringify(metadata).replace(/'/g, "''");
    query(`INSERT INTO cortana_events (timestamp, event_type, source, severity, message, metadata) VALUES (NOW(), 'calendar_prep_detector', 'prep-detector.sh', 'info', '${msg}', '${meta}'::jsonb);`);
  } catch {}

  return 0;
}

process.exit(main());
