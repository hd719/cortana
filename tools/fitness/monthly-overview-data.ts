#!/usr/bin/env npx tsx

import { localYmd } from "./signal-utils.js";
import { fetchFitnessWindowSummary, type FitnessWindowSummary } from "./facts-db.js";

type MonthWindow = {
  label: string;
  start: string;
  end: string;
};

type YearMonth = {
  year: number;
  month: number; // 1-12
};

function parseAnchor(anchorYmd: string): YearMonth {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(anchorYmd);
  if (!m) {
    const fallback = new Date();
    return { year: fallback.getUTCFullYear(), month: fallback.getUTCMonth() + 1 };
  }
  return {
    year: Number.parseInt(m[1], 10),
    month: Number.parseInt(m[2], 10),
  };
}

function shiftMonth(input: YearMonth, offset: number): YearMonth {
  const idx = (input.year * 12) + (input.month - 1) + offset;
  const year = Math.floor(idx / 12);
  const month = (idx % 12) + 1;
  return { year, month };
}

function monthDays(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0, 12, 0, 0)).getUTCDate();
}

function fmtYmd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthLabel(year: number, month: number): string {
  const anchor = new Date(Date.UTC(year, month - 1, 15, 12, 0, 0));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    year: "numeric",
  }).format(anchor);
}

export function monthlyWindows(anchorYmd = localYmd()): { current: MonthWindow; previous: MonthWindow } {
  const current = parseAnchor(anchorYmd);
  const previous = shiftMonth(current, -1);
  return {
    current: {
      label: monthLabel(current.year, current.month),
      start: fmtYmd(current.year, current.month, 1),
      end: fmtYmd(current.year, current.month, monthDays(current.year, current.month)),
    },
    previous: {
      label: monthLabel(previous.year, previous.month),
      start: fmtYmd(previous.year, previous.month, 1),
      end: fmtYmd(previous.year, previous.month, monthDays(previous.year, previous.month)),
    },
  };
}

export function completedMonthlyWindows(anchorYmd = localYmd()): { current: MonthWindow; previous: MonthWindow } {
  const completed = shiftMonth(parseAnchor(anchorYmd), -1);
  return monthlyWindows(fmtYmd(completed.year, completed.month, 1));
}

function delta(current: number | null, previous: number | null): { delta: number | null; delta_pct: number | null } {
  if (current == null || previous == null) return { delta: null, delta_pct: null };
  const d = Number((current - previous).toFixed(2));
  const pct = previous !== 0 ? Number((((current - previous) / previous) * 100).toFixed(2)) : null;
  return { delta: d, delta_pct: pct };
}

function trajectory(current: FitnessWindowSummary, previous: FitnessWindowSummary): "improving" | "stable" | "regressing" | "unknown" {
  if (current.days_with_data < 8 || previous.days_with_data < 8) return "unknown";
  const readiness = delta(current.avg_readiness, previous.avg_readiness).delta ?? 0;
  const sleep = delta(current.avg_sleep_hours, previous.avg_sleep_hours).delta ?? 0;
  const strain = delta(current.avg_whoop_strain, previous.avg_whoop_strain).delta ?? 0;
  if (readiness >= 1.5 && sleep >= 0.2 && strain <= 1.5) return "improving";
  if (readiness <= -1.5 || sleep <= -0.2) return "regressing";
  return "stable";
}

function main(): void {
  const explicitAnchor = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : null;
  const anchorYmd = explicitAnchor ?? localYmd();
  const windows = explicitAnchor ? monthlyWindows(anchorYmd) : completedMonthlyWindows(anchorYmd);

  const current = fetchFitnessWindowSummary(windows.current.start, windows.current.end);
  const previous = fetchFitnessWindowSummary(windows.previous.start, windows.previous.end);

  const out = {
    generated_at: new Date().toISOString(),
    anchor_date: anchorYmd,
    reporting_mode: explicitAnchor ? "anchor_month" : "most_recent_completed_month",
    source: "db:cortana_fitness_daily_facts",
    month_windows: windows,
    trajectory: trajectory(current, previous),
    current,
    previous,
    deltas: {
      readiness: delta(current.avg_readiness, previous.avg_readiness),
      sleep_hours: delta(current.avg_sleep_hours, previous.avg_sleep_hours),
      whoop_strain: delta(current.avg_whoop_strain, previous.avg_whoop_strain),
      tonal_sessions: delta(current.total_tonal_sessions, previous.total_tonal_sessions),
      tonal_volume: delta(current.total_tonal_volume, previous.total_tonal_volume),
      protein_avg_daily: delta(current.avg_protein_g, previous.avg_protein_g),
      hydration_liters: delta(current.avg_hydration_liters, previous.avg_hydration_liters),
      steps_total: delta(current.total_steps, previous.total_steps),
      steps_avg_daily: delta(current.avg_daily_steps, previous.avg_daily_steps),
    },
    data_quality: {
      days_with_data: current.days_with_data,
      has_minimum_coverage: current.days_with_data >= 14,
      hydration_coverage_days: current.days_with_hydration,
      step_coverage_days: current.days_with_steps,
      protein_coverage_days: current.days_with_protein,
    },
    notes: [
      "Monthly overview uses DB snapshots only (no live Whoop/Tonal fetches).",
      "Hydration remains null unless provided by future Whoop hydration ingestion or manual hydration logs.",
    ],
  };

  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
