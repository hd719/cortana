#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { renderBriefSections } from "./brief-assembler.js";
import { resolveRepoPath } from "../lib/paths.js";

const ET = "America/New_York";
const DEFAULT_LOG = "/tmp/daily-command-brief.log";
const FITNESS_DATA_SCRIPT = resolveRepoPath("tools", "fitness", "morning-brief-data.ts");
const MARKET_INTEL_SCRIPT = resolveRepoPath("tools", "market-intel", "market-intel.sh");

export type BriefData = {
  nowEt: string;
  calendar: string[];
  fitness: {
    recoveryScore?: number;
    sleepPerformance?: number;
    whoopWorkoutsToday: string[];
    tonalWorkoutsToday: string[];
    status: "ok" | "degraded";
  };
  market: {
    headline: string;
    bullets: string[];
    status: "ok" | "degraded";
  };
  tasks: {
    ready: Array<{ title: string; priority: number; due_at: string | null }>;
    overdueCount: number;
    dueTodayCount: number;
    status: "ok" | "degraded";
  };
};

function run(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const p = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: (p.status ?? 1) === 0,
    stdout: (p.stdout ?? "").trim(),
    stderr: (p.stderr ?? "").trim(),
  };
}

function nowEtString(d = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

function parseCalendar(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
    .filter((x) => !/^ID\s+START\s+END\s+SUMMARY$/i.test(x))
    .filter((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x))
    .map((line) => {
      const parts = line.split(/\t+/).map((x) => x.trim());
      if (parts.length >= 4) {
        const start = parts[1] || "time tbd";
        const summary = parts.slice(3).join(" ");
        return `${start} — ${summary}`;
      }
      return line;
    })
    .slice(0, 4);
}

function recommendationFromRecovery(score?: number): string {
  if (typeof score !== "number" || Number.isNaN(score)) return "Protect energy early; keep schedule conservative until recovery data is healthy.";
  if (score >= 67) return "Green recovery: run one high-cognitive block before noon, then one physical block.";
  if (score >= 34) return "Yellow recovery: avoid context-switching and cap deep work to 2 focused blocks.";
  return "Red recovery: prioritize sleep debt recovery and execute only must-win tasks.";
}

function recommendationFromTasks(overdue: number, dueToday: number): string {
  if (overdue > 0) return `Clear ${overdue} overdue item(s) first before starting any net-new work.`;
  if (dueToday > 0) return `Front-load due-today items (${dueToday}) in the first execution block.`;
  return "No urgent blockers: execute highest-value ready task, then advance strategic work.";
}

function buildBrief(data: BriefData): string {
  const fitnessWhoop = data.fitness.whoopWorkoutsToday.length ? data.fitness.whoopWorkoutsToday.join(", ") : "none";
  const fitnessTonal = data.fitness.tonalWorkoutsToday.length ? data.fitness.tonalWorkoutsToday.join(", ") : "none";

  return renderBriefSections({
    heading: `🧭 Brief - Daily Command Brief (${data.nowEt} ET)`,
    sections: [
      {
        title: "1) 📅 Calendar Command Window",
        items: data.calendar.length ? data.calendar : ["No calendar events found for today."],
        recommendation: "Anchor your day around the earliest fixed commitment and protect one uninterrupted focus block.",
      },
      {
        title: "2) 🏋️ Recovery & Fitness",
        items: [
          `Recovery: ${data.fitness.recoveryScore ?? "unavailable"}`,
          `Sleep performance: ${data.fitness.sleepPerformance ?? "unavailable"}%`,
          `Whoop workouts today: ${fitnessWhoop}`,
          `Tonal workouts today: ${fitnessTonal}`,
        ],
        recommendation: recommendationFromRecovery(data.fitness.recoveryScore),
      },
      {
        title: "3) 📈 Market Intelligence",
        items: [`Pulse: ${data.market.headline}`, ...(data.market.bullets.length ? data.market.bullets : ["Market pulse unavailable."])],
        recommendation: "Avoid impulsive positioning at open; make one deliberate check-in after the first hour.",
      },
      {
        title: "4) ✅ Task Board Execution",
        items: [
          ...(data.tasks.ready.length
            ? data.tasks.ready.slice(0, 3).map((t) => `P${t.priority}: ${t.title}${t.due_at ? ` (due ${t.due_at})` : ""}`)
            : ["No ready tasks found."]),
          `Overdue: ${data.tasks.overdueCount} | Due today: ${data.tasks.dueTodayCount}`,
        ],
        recommendation: recommendationFromTasks(data.tasks.overdueCount, data.tasks.dueTodayCount),
      },
    ],
  });
}

function collectData(): BriefData {
  const nowEt = nowEtString();

  const cal = run("gog", ["--account", "hameldesai3@gmail.com", "cal", "list", "Clawdbot-Calendar", "--from", "today", "--plain"]);
  const calendar = cal.ok ? parseCalendar(cal.stdout) : [];

  const fit = run("npx", ["tsx", FITNESS_DATA_SCRIPT]);
  let fitness: BriefData["fitness"] = { whoopWorkoutsToday: [], tonalWorkoutsToday: [], status: "degraded" };
  if (fit.ok) {
    try {
      const parsed = JSON.parse(fit.stdout || "{}");
      fitness = {
        recoveryScore: Number(parsed?.recovery?.score ?? NaN),
        sleepPerformance: Number(parsed?.sleep?.performance ?? NaN),
        whoopWorkoutsToday: Array.isArray(parsed?.whoop_workouts_today)
          ? parsed.whoop_workouts_today.slice(0, 3).map((x: any) => String(x?.sport ?? "workout"))
          : [],
        tonalWorkoutsToday: Array.isArray(parsed?.tonal_workouts_today)
          ? parsed.tonal_workouts_today.slice(0, 3).map((x: any) => `volume ${String(x?.volume ?? "?")}`)
          : [],
        status: "ok",
      };
      if (!Number.isFinite(fitness.recoveryScore as number)) fitness.recoveryScore = undefined;
      if (!Number.isFinite(fitness.sleepPerformance as number)) fitness.sleepPerformance = undefined;
    } catch {
      // keep degraded defaults
    }
  }

  const marketRun = run(MARKET_INTEL_SCRIPT, ["--pulse"]);
  const marketLines = (marketRun.stdout || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const market = {
    headline: marketLines[0] ?? "Unavailable",
    bullets: marketLines.slice(1, 4),
    status: marketRun.ok ? ("ok" as const) : ("degraded" as const),
  };

  const tasksRun = run("bash", ["-lc", "export PATH=\"/opt/homebrew/opt/postgresql@17/bin:$PATH\" && psql cortana -t -A -c \"WITH q AS (SELECT title, priority, due_at, CASE WHEN due_at < NOW() THEN 'OVERDUE' WHEN due_at < NOW() + INTERVAL '24 hour' THEN 'DUE_TODAY' ELSE 'UPCOMING' END AS urgency FROM cortana_tasks WHERE status='ready' ORDER BY priority ASC, due_at ASC NULLS LAST LIMIT 8) SELECT COALESCE(json_build_object('ready', COALESCE((SELECT json_agg(json_build_object('title', title, 'priority', priority, 'due_at', to_char(due_at, 'Mon DD HH12:MI AM')) ORDER BY priority ASC) FROM q), '[]'::json), 'overdue', COALESCE((SELECT COUNT(*) FROM q WHERE urgency='OVERDUE'),0), 'due_today', COALESCE((SELECT COUNT(*) FROM q WHERE urgency='DUE_TODAY'),0))::text, '{}'::text);\""]);

  let tasks: BriefData["tasks"] = { ready: [], overdueCount: 0, dueTodayCount: 0, status: "degraded" };
  if (tasksRun.ok) {
    try {
      const parsed = JSON.parse(tasksRun.stdout || "{}");
      tasks = {
        ready: Array.isArray(parsed.ready)
          ? parsed.ready.map((x: any) => ({ title: String(x.title ?? "Untitled"), priority: Number(x.priority ?? 3), due_at: x.due_at ? String(x.due_at) : null }))
          : [],
        overdueCount: Number(parsed.overdue ?? 0),
        dueTodayCount: Number(parsed.due_today ?? 0),
        status: "ok",
      };
    } catch {
      // keep degraded defaults
    }
  }

  return { nowEt, calendar, fitness, market, tasks };
}

function appendLog(line: string, logPath = DEFAULT_LOG): void {
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
}

export function runDailyCommandBrief(opts: { dryRun?: boolean; logPath?: string } = {}): number {
  try {
    const data = collectData();
    const brief = buildBrief(data);
    process.stdout.write(`${brief}\n`);
    appendLog(`status=ok dryRun=${Boolean(opts.dryRun)} calendar=${data.calendar.length} tasks=${data.tasks.ready.length}`, opts.logPath ?? DEFAULT_LOG);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendLog(`status=error message=${msg.replace(/\s+/g, " ")}`, opts.logPath ?? DEFAULT_LOG);
    console.error(`Daily command brief failed: ${msg}`);
    return 1;
  }
}

if (process.argv[1] && (import.meta.url === `file://${process.argv[1]}` || process.argv[1].includes("daily-command-brief.ts"))) {
  const dryRun = process.argv.includes("--dry-run");
  process.exit(runDailyCommandBrief({ dryRun }));
}

export { buildBrief, recommendationFromRecovery, recommendationFromTasks, parseCalendar };
