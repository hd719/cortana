#!/usr/bin/env npx tsx
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { runPsql, withPostgresPath } from "../../tools/lib/db.js";
import { resolveHomePath } from "../../tools/lib/paths.js";

type GogResponse = { events?: Array<Record<string, any>> };

const env = withPostgresPath(process.env);
const sentFile = resolveHomePath("clawd", "cortical-loop", "state", "calendar-alerts-sent.txt");

function psqlExec(sql: string): void {
  void runPsql(sql, { args: ["-X", "-q"], env, stdio: "ignore" });
}

function parseStartEpoch(start: string): number | null {
  if (!start) return null;
  const parsed = Date.parse(start);
  if (Number.isNaN(parsed)) return null;
  return Math.floor(parsed / 1000);
}

function main(): void {
  const gog = spawnSync(
    "gog",
    [
      "--account",
      "hameldesai3@gmail.com",
      "calendar",
      "events",
      "60e1d0b7ca7586249ee94341d65076f28d9b9f3ec67d89b0709371c0ff82d517@group.calendar.google.com",
      "--from",
      "today",
      "--to",
      "tomorrow",
      "--json",
    ],
    { env, encoding: "utf8" }
  );

  const eventsRaw = (gog.stdout ?? "").toString().trim();
  if ((gog.status ?? 1) !== 0 || !eventsRaw) process.exit(0);

  let parsed: GogResponse;
  try {
    parsed = JSON.parse(eventsRaw) as GogResponse;
  } catch {
    process.exit(0);
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  fs.mkdirSync(path.dirname(sentFile), { recursive: true });
  if (!fs.existsSync(sentFile)) fs.writeFileSync(sentFile, "", "utf8");

  const sentSet = new Set(
    fs
      .readFileSync(sentFile, "utf8")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  for (const event of parsed.events ?? []) {
    const start = event?.start?.dateTime ?? event?.start?.date ?? "";
    if (!start) continue;

    const startEpoch = parseStartEpoch(start);
    if (!startEpoch) continue;

    const minsUntil = Math.floor((startEpoch - nowEpoch) / 60);
    const title = event?.summary ?? "Untitled";
    const eventId = event?.id ?? "";

    for (const threshold of [60, 15, 5]) {
      if (minsUntil <= threshold && minsUntil > 0) {
        const alertKey = `${eventId}_${threshold}`;
        if (!sentSet.has(alertKey)) {
          const payload = JSON.stringify({
            title,
            start,
            minutes_until: minsUntil,
            threshold,
          }).replace(/'/g, "''");

          psqlExec(`INSERT INTO cortana_event_stream (source, event_type, payload) VALUES ('calendar', 'event_approaching', '${payload}'::jsonb);`);

          fs.appendFileSync(sentFile, `${alertKey}\n`, "utf8");
          sentSet.add(alertKey);
        }
      }
    }
  }

  try {
    const st = fs.statSync(sentFile);
    if (Date.now() - st.mtimeMs > 24 * 60 * 60 * 1000) {
      fs.truncateSync(sentFile, 0);
    }
  } catch {
    // ignore
  }
}

main();
