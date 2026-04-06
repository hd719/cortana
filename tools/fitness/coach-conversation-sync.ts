#!/usr/bin/env npx tsx

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { upsertCoachCaffeine, upsertCoachConversation, updateLatestDecisionCompliance } from "./coach-db.js";
import { coachCheckinDateLocal, hasCoachCheckinSignal, parseCoachCheckin } from "./post-workout-note-parser.js";
import { upsertCoachCheckin } from "./checkin-db.js";
import { localYmd } from "./signal-utils.js";

type ContentBlock = { type?: string; text?: string };
type SessionLine = {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    timestamp?: number;
    content?: ContentBlock[];
  };
};

function parseTimestamp(row: SessionLine): string | null {
  if (typeof row.timestamp === "string" && row.timestamp.length > 0) return row.timestamp;
  const ts = row.message?.timestamp;
  if (typeof ts === "number" && Number.isFinite(ts)) return new Date(ts).toISOString();
  return null;
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function classifyIntent(text: string): string | null {
  const t = text.toLowerCase();
  if (t.includes("whoop") || t.includes("recovery") || t.includes("readiness")) return "readiness_check";
  if (t.includes("workout") || t.includes("run") || t.includes("lift")) return "training_update";
  if (t.includes("meal") || t.includes("protein") || t.includes("diet") || t.includes("nutrition")) return "nutrition_check";
  if (t.includes("sleep")) return "sleep_check";
  return null;
}



function extractCaffeineEvents(text: string, tsUtc: string): Array<{ amountMg: number; source: string | null; consumedAtUtc: string; sourceKeySeed: string }> {
  const out: Array<{ amountMg: number; source: string | null; consumedAtUtc: string; sourceKeySeed: string }> = [];
  const lower = text.toLowerCase();
  const lines = text.split(/\r?\n/).filter((l) => /caffeine|coffee|espresso|energy drink|matcha|pre[- ]?workout|tea/.test(l.toLowerCase()));
  const sourceHints = ["coffee", "espresso", "energy drink", "matcha", "pre-workout", "tea", "caffeine"];

  const harvest = (chunk: string) => {
    const mgMatches = [...chunk.matchAll(/(\d{1,4})\s*mg\b/gi)];
    if (!mgMatches.length) return;
    const source = sourceHints.find((h) => chunk.toLowerCase().includes(h)) ?? null;
    for (const m of mgMatches) {
      const mg = Number.parseInt(m[1] ?? "", 10);
      if (!Number.isFinite(mg) || mg <= 0) continue;
      out.push({ amountMg: mg, source, consumedAtUtc: tsUtc, sourceKeySeed: `${tsUtc}|${chunk}|${mg}` });
    }
  };

  if (lines.length) {
    for (const l of lines) harvest(l);
  } else if (/caffeine/.test(lower)) {
    harvest(text);
  }

  return out;
}

function syncFile(filePath: string, cutoffMs: number): { scanned: number; upserted: number; errors: number } {
  const raw = fs.readFileSync(filePath, "utf8");
  let scanned = 0;
  let upserted = 0;
  let errors = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let row: SessionLine;
    try {
      row = JSON.parse(line) as SessionLine;
    } catch {
      continue;
    }
    if (row.type !== "message") continue;
    const role = row.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const ts = parseTimestamp(row);
    if (!ts) continue;
    const tsMs = new Date(ts).getTime();
    if (Number.isNaN(tsMs) || tsMs < cutoffMs) continue;

    const blocks = Array.isArray(row.message?.content) ? row.message?.content : [];
    const text = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => (b.text ?? "").trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 8000);
    if (!text) continue;

    scanned += 1;
    const sourceKey = `spartan:${path.basename(filePath)}:${digest(`${ts}|${role}|${text}`)}`;
    const parsedCheckin = role === "user" ? parseCoachCheckin(text, { timestampUtc: ts }) : null;
    const linkedStateDate = parsedCheckin ? coachCheckinDateLocal(ts) : null;
    const linkedDecisionKey = parsedCheckin ? `spartan:decision:morning:${linkedStateDate}` : null;
    const parsedEntities = parsedCheckin
      ? {
          checkin_type: parsedCheckin.checkinType,
          compliance_status: parsedCheckin.complianceStatus,
          completed: parsedCheckin.completed,
          missed: parsedCheckin.missed,
          soreness_score: parsedCheckin.sorenessScore,
          pain_flag: parsedCheckin.painFlag,
          motivation_score: parsedCheckin.motivationScore,
          schedule_constraints: parsedCheckin.scheduleConstraints,
          schedule_constraint: parsedCheckin.scheduleConstraint,
          confidence: parsedCheckin.confidence,
          matched_signals: parsedCheckin.matchedSignals,
        }
      : null;
    const result = upsertCoachConversation({
      sourceKey,
      tsUtc: ts,
      channel: "telegram",
      direction: role === "user" ? "inbound" : "outbound",
      messageText: text,
      intent: role === "user" ? classifyIntent(text) : null,
      linkedStateDate,
      linkedDecisionKey,
      parsedEntities,
      tags: {
        source_file: path.basename(filePath),
        source_agent: "spartan",
        ...(parsedEntities ? { parsed_entities: parsedEntities } : {}),
      },
    });
    if (result.ok) upserted += 1;
    else errors += 1;

    if (role === "user") {
      if (parsedCheckin && parsedCheckin.complianceStatus !== "unknown") {
        const c = updateLatestDecisionCompliance({
          status: parsedCheckin.complianceStatus,
          note: parsedCheckin.matchedSignals.join(", "),
        });
        if (!c.ok) errors += 1;
      }

      if (parsedCheckin && hasCoachCheckinSignal(parsedCheckin)) {
        const checkin = upsertCoachCheckin({
          sourceKey,
          tsUtc: ts,
          dateLocal: coachCheckinDateLocal(ts),
          checkinType: parsedCheckin.checkinType,
          complianceStatus: parsedCheckin.complianceStatus === "unknown" ? null : parsedCheckin.complianceStatus,
          sorenessScore: parsedCheckin.sorenessScore,
          painFlag: parsedCheckin.painFlag,
          motivationScore: parsedCheckin.motivationScore,
          scheduleConstraint: parsedCheckin.scheduleConstraint,
          rawText: text,
          parsed: {
            ...parsedCheckin,
            source_file: path.basename(filePath),
            source_agent: "spartan",
            source_key: sourceKey,
          },
        });
        if (!checkin.ok) errors += 1;
      }

      const caffeine = extractCaffeineEvents(text, ts);
      for (const event of caffeine) {
        const u = upsertCoachCaffeine({
          sourceKey: `spartan:caffeine:${digest(event.sourceKeySeed)}`,
          dateLocal: localYmd("America/New_York", new Date(event.consumedAtUtc)),
          consumedAtUtc: event.consumedAtUtc,
          amountMg: event.amountMg,
          source: event.source,
          notes: "parsed_from_chat",
        });
        if (!u.ok) errors += 1;
      }
    }
  }

  return { scanned, upserted, errors };
}

function main(): void {
  const daysArg = process.argv.find((a) => a.startsWith("--days="));
  const days = Math.max(1, Math.min(30, Number.parseInt((daysArg ?? "--days=7").split("=")[1] ?? "7", 10) || 7));
  const cutoffMs = Date.now() - days * 24 * 3600 * 1000;

  const dir = path.join(os.homedir(), ".openclaw", "agents", "spartan", "sessions");
  if (!fs.existsSync(dir)) {
    process.stdout.write(`${JSON.stringify({ ok: true, scanned: 0, upserted: 0, errors: 0, note: "sessions_dir_missing" })}\n`);
    return;
  }

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ filePath: path.join(dir, f), mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 40);

  let scanned = 0;
  let upserted = 0;
  let errors = 0;
  for (const item of files) {
    const r = syncFile(item.filePath, cutoffMs);
    scanned += r.scanned;
    upserted += r.upserted;
    errors += r.errors;
  }

  process.stdout.write(`${JSON.stringify({ ok: errors === 0, scanned, upserted, errors, files: files.length, days })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
