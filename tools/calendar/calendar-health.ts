#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGogWithEnv } from "../gog/gog-with-env.js";

const DEFAULT_ACCOUNT = "hameldesai3@gmail.com";
const DEFAULT_CALENDAR_ID =
  "60e1d0b7ca7586249ee94341d65076f28d9b9f3ec67d89b0709371c0ff82d517@group.calendar.google.com";
const DEFAULT_VDIR_TOKEN = path.join(
  os.homedir(),
  ".config",
  "vdirsyncer",
  "google_token.json",
);
const DEFAULT_VDIR_MIRROR = path.join(
  os.homedir(),
  ".local",
  "share",
  "vdirsyncer",
  "calendars",
  "Clawdbot-Calendar",
);
const MAX_LEGACY_STALE_HOURS = 24;

type HealthStatus = "ok" | "warn" | "error";

type CalendarHealth = {
  status: HealthStatus;
  checkedAt: string;
  sourceOfTruth: "gog";
  gog: {
    ok: boolean;
    account: string;
    calendarId: string;
    eventCount: number | null;
    error: string | null;
  };
  legacyVdirsyncer: {
    required: boolean;
    tokenPresent: boolean;
    mirrorPath: string;
    newestIcsAt: string | null;
    staleHours: number | null;
    status: "ok" | "stale" | "missing_token" | "missing_mirror";
    note: string;
  };
};

function compact(text: string, max = 240): string {
  const normalized = text.replace(/\\s+/g, " ").trim();
  if (!normalized) return "unknown";
  return normalized.length <= max
    ? normalized
    : `${normalized.slice(0, max - 3)}...`;
}

function newestIcsAt(mirrorPath: string): string | null {
  let newest = 0;
  try {
    for (const name of fs.readdirSync(mirrorPath)) {
      if (!name.endsWith(".ics")) continue;
      const filePath = path.join(mirrorPath, name);
      const mtime = fs.statSync(filePath).mtimeMs;
      if (mtime > newest) newest = mtime;
    }
  } catch {
    return null;
  }
  return newest > 0 ? new Date(newest).toISOString() : null;
}

function checkGog(account: string, calendarId: string) {
  const result = runGogWithEnv([
    "--account",
    account,
    "calendar",
    "events",
    calendarId,
    "--from",
    "today",
    "--to",
    "tomorrow",
    "--json",
    "--no-input",
  ]);
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if ((result.status ?? 1) !== 0) {
    return {
      ok: false,
      eventCount: null,
      error: compact(stderr || stdout || "gog calendar probe failed"),
    };
  }
  try {
    const parsed = JSON.parse(stdout || "{}") as { events?: unknown[] };
    return {
      ok: true,
      eventCount: Array.isArray(parsed.events) ? parsed.events.length : null,
      error: null,
    };
  } catch {
    return {
      ok: false,
      eventCount: null,
      error: "gog calendar probe returned invalid JSON",
    };
  }
}

function checkLegacyVdirsyncer(
  required: boolean,
  tokenPath: string,
  mirrorPath: string,
): CalendarHealth["legacyVdirsyncer"] {
  const tokenPresent = fs.existsSync(tokenPath);
  const newest = newestIcsAt(mirrorPath);
  const staleHours = newest
    ? (Date.now() - Date.parse(newest)) / 3_600_000
    : null;
  const mirrorExists = fs.existsSync(mirrorPath);
  let status: CalendarHealth["legacyVdirsyncer"]["status"] = "ok";
  if (!tokenPresent) status = "missing_token";
  else if (!mirrorExists || !newest) status = "missing_mirror";
  else if (staleHours != null && staleHours > MAX_LEGACY_STALE_HOURS)
    status = "stale";

  const note = required
    ? "legacy vdirsyncer mirror is required by this caller"
    : "legacy vdirsyncer mirror is advisory; do not run vdirsyncer sync headlessly when the token is missing";

  return {
    required,
    tokenPresent,
    mirrorPath,
    newestIcsAt: newest,
    staleHours,
    status,
    note,
  };
}

export function buildCalendarHealth(env = process.env): CalendarHealth {
  const account = env.GOG_ACCOUNT || DEFAULT_ACCOUNT;
  const calendarId = env.CLAWDBOT_CALENDAR_ID || DEFAULT_CALENDAR_ID;
  const requireVdirsyncer =
    env.REQUIRE_VDIRSYNCER_CALENDAR === "1" ||
    env.REQUIRE_VDIRSYNCER_CALENDAR === "true";
  const vdirTokenPath = env.VDIRSYNCER_GOOGLE_TOKEN || DEFAULT_VDIR_TOKEN;
  const vdirMirrorPath = env.VDIRSYNCER_CLAWDBOT_MIRROR || DEFAULT_VDIR_MIRROR;
  const gog = checkGog(account, calendarId);
  const legacyVdirsyncer = checkLegacyVdirsyncer(
    requireVdirsyncer,
    vdirTokenPath,
    vdirMirrorPath,
  );
  const status: HealthStatus = !gog.ok
    ? "error"
    : requireVdirsyncer && legacyVdirsyncer.status !== "ok"
      ? "warn"
      : "ok";

  return {
    status,
    checkedAt: new Date().toISOString(),
    sourceOfTruth: "gog",
    gog: {
      ok: gog.ok,
      account,
      calendarId,
      eventCount: gog.eventCount,
      error: gog.error,
    },
    legacyVdirsyncer,
  };
}

export function main(): void {
  const json = process.argv.includes("--json");
  const health = buildCalendarHealth();
  if (json) {
    console.log(JSON.stringify(health, null, 2));
  } else if (health.status === "error") {
    console.log(
      `calendar health error: ${health.gog.error ?? "gog calendar probe failed"}`,
    );
  } else if (health.status === "warn") {
    console.log(
      `calendar health warning: legacy vdirsyncer ${health.legacyVdirsyncer.status}`,
    );
  } else {
    console.log("calendar health ok");
  }
  process.exit(health.status === "error" ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
