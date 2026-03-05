#!/usr/bin/env npx tsx
import { queryJson } from "../lib/db.js";
type TaskRow = {
  id: number;
  title: string;
  description: string | null;
  priority: number | null;
  status: string;
  due_at: string | null;
};

type SitrepRow = {
  domain: string;
  key: string;
  value: unknown;
};

type Pillar = "time" | "health" | "wealth" | "career";

type Action = {
  pillar: Pillar;
  text: string;
  minutes: number;
  source: "task" | "sitrep" | "fallback";
};

const PILLARS: Pillar[] = ["time", "health", "wealth", "career"];

const MINUTES_BY_PILLAR: Record<Pillar, number> = {
  time: 30,
  health: 45,
  wealth: 20,
  career: 50,
};

const KEYWORDS: Record<Pillar, string[]> = {
  time: ["calendar", "schedule", "plan", "block", "focus", "email", "inbox", "organize"],
  health: ["workout", "sleep", "whoop", "tonal", "recovery", "walk", "strain", "bed"],
  wealth: ["portfolio", "market", "mortgage", "rate", "stock", "finance", "trade", "fed"],
  career: ["career", "master", "class", "assignment", "project", "ship", "interview", "resilience"],
};

export function inferPillar(text: string): Pillar {
  const lc = text.toLowerCase();
  let best: { pillar: Pillar; score: number } = { pillar: "time", score: -1 };
  for (const pillar of PILLARS) {
    const score = KEYWORDS[pillar].reduce((acc, kw) => acc + (lc.includes(kw) ? 1 : 0), 0);
    if (score > best.score) best = { pillar, score };
  }
  return best.pillar;
}

function shorten(input: string, maxChars = 78): string {
  const clean = input.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 1).trimEnd()}…`;
}

function parseJsonish(value: unknown): any {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

function fallbackByPillar(sitrepMap: Map<string, any>): Record<Pillar, string> {
  const recovery = parseJsonish(sitrepMap.get("health.whoop_recovery"));
  const recScore = recovery?.score?.recovery_score;
  const qqq = parseJsonish(sitrepMap.get("finance.stock_QQQ"));
  const qqqPrice = qqq?.price;
  const events = parseJsonish(sitrepMap.get("calendar.events_48h"));
  const eventCount = events?.count;

  return {
    time: eventCount ? `Anchor your first focus block before calendar load (${eventCount} events in 48h).` : "Reserve a protected 30m block at 6:30 AM for planning and triage.",
    health: typeof recScore === "number" ? `Recovery is ${recScore}%; train to match readiness, then lock bedtime tonight.` : "Move your body early and protect sleep with a hard 9:30 PM cutoff.",
    wealth: typeof qqqPrice === "number" ? `Do a 20m risk check: QQQ ${qqqPrice}; verify no portfolio concentration drift.` : "Run a quick portfolio and mortgage-rate pulse before market open.",
    career: "Ship one visible artifact today (class or work) before noon to compound momentum.",
  };
}

export function buildActions(tasks: TaskRow[], sitrepRows: SitrepRow[]): Action[] {
  const sitrepMap = new Map<string, any>();
  for (const row of sitrepRows) sitrepMap.set(`${row.domain}.${row.key}`, row.value);
  const fallback = fallbackByPillar(sitrepMap);

  const chosen = new Map<Pillar, Action>();
  const sorted = [...tasks].sort((a, b) => {
    const pa = a.priority ?? 3;
    const pb = b.priority ?? 3;
    if (pa !== pb) return pa - pb;
    const da = a.due_at ? new Date(a.due_at).getTime() : Number.POSITIVE_INFINITY;
    const db = b.due_at ? new Date(b.due_at).getTime() : Number.POSITIVE_INFINITY;
    return da - db;
  });

  for (const task of sorted) {
    const raw = `${task.title} ${task.description ?? ""}`;
    const pillar = inferPillar(raw);
    if (chosen.has(pillar)) continue;
    chosen.set(pillar, {
      pillar,
      text: shorten(task.title),
      minutes: MINUTES_BY_PILLAR[pillar],
      source: "task",
    });
  }

  for (const pillar of PILLARS) {
    if (chosen.has(pillar)) continue;
    chosen.set(pillar, {
      pillar,
      text: shorten(fallback[pillar]),
      minutes: MINUTES_BY_PILLAR[pillar],
      source: sitrepMap.size > 0 ? "sitrep" : "fallback",
    });
  }

  return PILLARS.map((p) => chosen.get(p)!);
}

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

export function renderScorecard(actions: Action[], mit: string): string {
  const line = (label: string, minutes: number, text: string) => `• ${label} (${minutes}m): ${text}`;
  const rows = [
    "🎯 Daily Mission Scorecard v1",
    line("Time", actions.find((a) => a.pillar === "time")!.minutes, actions.find((a) => a.pillar === "time")!.text),
    line("Health", actions.find((a) => a.pillar === "health")!.minutes, actions.find((a) => a.pillar === "health")!.text),
    line("Wealth", actions.find((a) => a.pillar === "wealth")!.minutes, actions.find((a) => a.pillar === "wealth")!.text),
    line("Career", actions.find((a) => a.pillar === "career")!.minutes, actions.find((a) => a.pillar === "career")!.text),
    `• MIT (60m): ${shorten(mit, 90)}`,
  ];

  let output = rows.join("\n");
  while (wordCount(output) > 180) {
    const idx = rows.findIndex((r) => r.startsWith("• Career"));
    if (idx < 0) break;
    rows[idx] = rows[idx].replace(/: .+$/, ": Ship one meaningful artifact by noon.");
    output = rows.join("\n");
    if (rows[idx].includes("meaningful artifact")) break;
  }
  return output;
}

export function validateScorecard(output: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const words = wordCount(output);
  if (words > 180) errors.push(`word_limit_exceeded:${words}`);
  for (const need of ["Time", "Health", "Wealth", "Career", "MIT"]) {
    if (!output.includes(`• ${need}`)) errors.push(`missing_${need.toLowerCase()}`);
  }
  if (!/\(\d+m\)/.test(output)) errors.push("missing_minutes");
  return { ok: errors.length === 0, errors };
}

function fetchTasks(): TaskRow[] {
  return queryJson<TaskRow>(`
    SELECT COALESCE(json_agg(t), '[]'::json)
    FROM (
      SELECT id, title, description, priority, status, due_at
      FROM cortana_tasks
      WHERE status IN ('ready','in_progress')
      ORDER BY priority ASC, due_at ASC NULLS LAST, created_at ASC
      LIMIT 30
    ) t;
  `);
}

function fetchSitrep(): SitrepRow[] {
  return queryJson<SitrepRow>(`
    SELECT COALESCE(json_agg(s), '[]'::json)
    FROM (
      SELECT domain, key, value
      FROM cortana_sitrep_latest
      WHERE domain IN ('calendar','health','finance')
    ) s;
  `);
}

function pickMit(actions: Action[], tasks: TaskRow[]): string {
  const topTask = tasks.sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3))[0];
  if (topTask?.title) return topTask.title;
  return actions.find((a) => a.pillar === "career")?.text ?? "Finalize your top priority deliverable early.";
}

export function main(): void {
  const args = new Set(process.argv.slice(2));
  const tasks = fetchTasks();
  const sitrep = fetchSitrep();
  const actions = buildActions(tasks, sitrep);
  const mit = pickMit(actions, tasks);
  const output = renderScorecard(actions, mit);

  if (args.has("--json")) {
    const payload = {
      generated_at: new Date().toISOString(),
      words: wordCount(output),
      actions,
      mit,
      output,
      validation: validateScorecard(output),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (args.has("--validate")) {
    const result = validateScorecard(output);
    if (!result.ok) {
      process.stderr.write(`${JSON.stringify(result)}\n`);
      process.exit(1);
    }
  }

  process.stdout.write(`${output}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
