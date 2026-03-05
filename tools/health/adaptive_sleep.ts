#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import { runPsql } from "../lib/db.js";
type SleepInputs = {
  recovery_score: number;
  sleep_hours: number;
  strain: number;
  back_to_back_heavy: boolean;
  next_day_events: number;
  booked_hours: number;
  target_date: string;
};

const WHOOP_SLEEP_URL = "http://localhost:3033/whoop/sleep";
const WHOOP_DATA_URL = "http://localhost:3033/whoop/data";
const WHOOP_STRAIN_URL = "http://localhost:3033/whoop/strain";

function parseArgs(argv: string[]) {
  const args = {
    date: null as string | null,
    wakeTime: "05:45",
    json: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--date") args.date = argv[++i] ?? null;
    else if (a === "--wake-time") args.wakeTime = argv[++i] ?? args.wakeTime;
    else if (a === "--json") args.json = true;
    else if (a === "--dry-run") args.dryRun = true;
  }

  return args;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getTargetDate(dateArg: string | null): Date {
  if (dateArg) {
    return new Date(`${dateArg}T00:00:00`);
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

async function fetchJsonUrl(url: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWhoopSleep(): Promise<Record<string, any>> {
  try {
    const data = await fetchJsonUrl(WHOOP_SLEEP_URL);
    if (data && typeof data === "object") return data;
  } catch {
    // ignore
  }
  try {
    const data = await fetchJsonUrl(WHOOP_DATA_URL);
    if (data && typeof data === "object") return data;
  } catch {
    // ignore
  }
  return {};
}

async function fetchStrain(): Promise<Record<string, any>> {
  for (const url of [WHOOP_STRAIN_URL, WHOOP_DATA_URL]) {
    try {
      const data = await fetchJsonUrl(url);
      if (data && typeof data === "object") return data;
    } catch {
      continue;
    }
  }
  return {};
}

function getPath(payload: any, pathStr: string): any {
  let cur = payload;
  for (const part of pathStr.split(".")) {
    if (!cur || typeof cur !== "object") return null;
    cur = cur[part];
  }
  return cur;
}

function firstNumeric(payload: Record<string, any>, paths: string[], def = 0.0): number {
  for (const p of paths) {
    const v = getPath(payload, p);
    if (typeof v === "number") return v;
    if (typeof v === "string") {
      const n = Number.parseFloat(v);
      if (!Number.isNaN(n)) return n;
    }
  }
  return def;
}

function firstList(payload: Record<string, any>, paths: string[]): any[] {
  for (const p of paths) {
    const v = getPath(payload, p);
    if (Array.isArray(v)) return v;
  }
  return [];
}

function parseRecoverySleepHours(payload: Record<string, any>): [number, number] {
  let recovery = firstNumeric(payload, [
    "recovery_score",
    "recovery",
    "score",
    "latest.recovery.score",
    "sleep.recovery_score",
  ]);

  let sleepHours = firstNumeric(payload, [
    "sleep_hours",
    "hours",
    "sleep.duration_hours",
    "total_sleep_hours",
  ]);

  if (sleepHours <= 0) {
    const sleepMin = firstNumeric(payload, [
      "sleep_minutes",
      "sleep.duration_minutes",
      "total_sleep_minutes",
    ]);
    if (sleepMin > 0) sleepHours = sleepMin / 60.0;
  }

  if (recovery <= 1.0) recovery *= 100.0;

  return [recovery, sleepHours];
}

function parseStrain(payload: Record<string, any>): [number, boolean] {
  const current = firstNumeric(payload, ["strain", "day_strain", "latest.strain", "workout_strain"], 0.0);
  const series = firstList(payload, ["recent", "days", "strain_history", "last_3_days"]);
  const values: number[] = [];

  for (const item of series) {
    if (item && typeof item === "object") {
      const val = firstNumeric(item, ["strain", "value", "day_strain"], -1);
      if (val >= 0) values.push(val);
    } else if (typeof item === "number") {
      values.push(item);
    }
  }

  if (!values.length && current > 0) values.push(current);

  const heavyThreshold = 14.0;
  const backToBackHeavy = values.length >= 2 && values[0] >= heavyThreshold && values[1] >= heavyThreshold;

  return [current, backToBackHeavy];
}

function parseDt(raw: any): Date | null {
  if (raw && typeof raw === "object") raw = raw.dateTime ?? raw.date;
  if (typeof raw !== "string") return null;
  try {
    if (raw.length === 10) return new Date(`${raw}T00:00:00`);
    return new Date(raw.replace("Z", "+00:00"));
  } catch {
    return null;
  }
}

function fetchCalendarLoad(target: Date): [number, number] {
  const fromStr = formatDate(target);
  const to = new Date(target.getFullYear(), target.getMonth(), target.getDate() + 1);
  const toStr = formatDate(to);

  const cmd = [
    "gog",
    "cal",
    "list",
    "--all",
    "--from",
    fromStr,
    "--to",
    toStr,
    "--json",
    "--results-only",
    "--max",
    "100",
  ];

  const proc = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (proc.status !== 0) return [0, 0.0];

  let rows: any;
  try {
    rows = JSON.parse(proc.stdout || "");
  } catch {
    return [0, 0.0];
  }

  if (!Array.isArray(rows)) return [0, 0.0];

  let totalHours = 0.0;
  for (const ev of rows) {
    if (!ev || typeof ev !== "object") continue;
    const st = parseDt(ev.start);
    const en = parseDt(ev.end);
    if (st && en && en > st) totalHours += (en.getTime() - st.getTime()) / 3600000;
  }

  return [rows.length, Number(totalHours.toFixed(2))];
}

function classifyTier(inp: SleepInputs): string {
  const heavyDay = inp.next_day_events >= 6 || inp.booked_hours >= 6.0;
  if (inp.recovery_score < 50.0 || inp.back_to_back_heavy) return "red";
  if ((inp.recovery_score >= 50.0 && inp.recovery_score <= 70.0) || heavyDay) return "yellow";
  return "green";
}

function formatTime12(d: Date): string {
  let hours = d.getHours();
  const minutes = d.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours %= 12;
  if (hours === 0) hours = 12;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")} ${ampm}`;
}

function protocolForTier(tier: string, wakeTime: string): Record<string, string> {
  const [wakeH, wakeM] = wakeTime.split(":").map((v) => Number.parseInt(v, 10));
  const now = new Date();
  const wakeDt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), wakeH, wakeM, 0, 0);

  let sleepTargetHours = 7.75;
  let intensity = "Normal training is fine. Keep intensity planned.";
  if (tier === "yellow") {
    sleepTargetHours = 8.25;
    intensity = "Reduce intensity 10-20%. Prefer moderate/session quality over volume.";
  } else if (tier === "red") {
    sleepTargetHours = 8.75;
    intensity = "Aggressive recovery mode: mobility/zone2 only, skip max-effort lifting.";
  }

  const bedtime = new Date(wakeDt.getTime() - sleepTargetHours * 3600000);
  const windDown = new Date(bedtime.getTime() - 90 * 60000);
  const screenCutoff = new Date(bedtime.getTime() - 60 * 60000);

  return {
    bedtime_target: formatTime12(bedtime),
    wind_down_start: formatTime12(windDown),
    screen_cutoff: formatTime12(screenCutoff),
    workout_adjustment: intensity,
  };
}

async function buildInputs(target: Date): Promise<SleepInputs> {
  const sleepPayload = await fetchWhoopSleep();
  const strainPayload = await fetchStrain();

  const [recovery, sleepHours] = parseRecoverySleepHours(sleepPayload);
  const [strain, backToBackHeavy] = parseStrain(strainPayload);
  const [events, bookedHours] = fetchCalendarLoad(target);

  return {
    recovery_score: Number(recovery.toFixed(1)),
    sleep_hours: Number(sleepHours.toFixed(2)),
    strain: Number(strain.toFixed(1)),
    back_to_back_heavy: backToBackHeavy,
    next_day_events: events,
    booked_hours: bookedHours,
    target_date: formatDate(target),
  };
}

function sqlEscape(value: string): string {
  return (value || "").replace(/'/g, "''");
}

function insertPattern(inp: SleepInputs, tier: string, protocol: Record<string, string>): void {
  const metadata = {
    target_date: inp.target_date,
    recovery_score: inp.recovery_score,
    sleep_hours: inp.sleep_hours,
    strain: inp.strain,
    back_to_back_heavy: inp.back_to_back_heavy,
    next_day_events: inp.next_day_events,
    booked_hours: inp.booked_hours,
    protocol,
  };

  const sql =
    "INSERT INTO cortana_patterns (pattern_type, value, day_of_week, metadata) " +
    `VALUES ('adaptive_sleep_protocol', '${sqlEscape(tier)}', ` +
    "EXTRACT(DOW FROM NOW())::int, " +
    `'${sqlEscape(JSON.stringify(metadata))}'::jsonb);`;

  runPsql(sql, { db: "cortana", args: ["-X", "-v", "ON_ERROR_STOP=1"], stdio: "pipe" });
}

function formatTelegram(inp: SleepInputs, tier: string, protocol: Record<string, string>): string {
  const tierEmoji: Record<string, string> = { green: "\ud83d\udfe2", yellow: "\ud83d\udfe1", red: "\ud83d\udd34" };
  return [
    `${tierEmoji[tier]} Adaptive Sleep Protocol — ${inp.target_date}`,
    `Recovery: ${inp.recovery_score.toFixed(0)}% | Sleep: ${inp.sleep_hours.toFixed(2)}h | Strain: ${inp.strain.toFixed(1)}`,
    `Calendar load: ${inp.next_day_events} events / ${inp.booked_hours.toFixed(1)}h`,
    `Tier: ${tier.toUpperCase()}`,
    "",
    `\ud83d\udecf\ufe0f Bedtime target: ${protocol.bedtime_target}`,
    `\ud83c\udf19 Wind-down start: ${protocol.wind_down_start}`,
    `\ud83d\udcf5 Screen cutoff: ${protocol.screen_cutoff}`,
    `\ud83c\udfcb\ufe0f Workout adjustment: ${protocol.workout_adjustment}`,
  ].join("\n");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const target = getTargetDate(args.date);

  let inputs: SleepInputs;
  try {
    inputs = await buildInputs(target);
  } catch (err) {
    console.error(`adaptive_sleep failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const tier = classifyTier(inputs);
  const protocol = protocolForTier(tier, args.wakeTime);

  if (!args.dryRun) {
    insertPattern(inputs, tier, protocol);
  }

  const payload = {
    date: inputs.target_date,
    tier,
    inputs,
    protocol,
    telegram: formatTelegram(inputs, tier, protocol),
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(payload.telegram);
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
