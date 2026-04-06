#!/usr/bin/env npx tsx

import { localYmd } from "./signal-utils.js";
import { fetchAthleteStateRows, type AthleteStateDailyRow } from "./athlete-state-db.js";

type MonthWindow = {
  label: string;
  start: string;
  end: string;
};

type YearMonth = {
  year: number;
  month: number; // 1-12
};

type Trajectory =
  | "improving"
  | "stable"
  | "regressing"
  | "unknown";

export type AthleteStateWindowSummary = {
  start: string;
  end: string;
  days_with_data: number;
  days_with_readiness: number;
  days_with_sleep: number;
  days_with_protein: number;
  days_with_hydration: number;
  days_with_steps: number;
  days_with_body_weight: number;
  avg_readiness: number | null;
  avg_sleep_hours: number | null;
  avg_sleep_performance: number | null;
  avg_hrv: number | null;
  avg_rhr: number | null;
  avg_whoop_strain: number | null;
  avg_body_weight_kg: number | null;
  avg_active_energy_kcal: number | null;
  avg_resting_energy_kcal: number | null;
  avg_walking_running_distance_km: number | null;
  avg_body_fat_pct: number | null;
  avg_lean_mass_kg: number | null;
  total_tonal_sessions: number;
  total_tonal_volume: number;
  avg_protein_g: number | null;
  protein_days_on_target: number;
  avg_hydration_liters: number | null;
  total_steps: number;
  avg_daily_steps: number | null;
  days_with_recommendation: number;
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

function average(values: Array<number | null | undefined>): number | null {
  const nums = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (nums.length === 0) return null;
  return Number((nums.reduce((sum, value) => sum + value, 0) / nums.length).toFixed(2));
}

export function buildMonthlyWindowSummaryFromState(
  rows: AthleteStateDailyRow[],
  start: string,
  end: string,
): AthleteStateWindowSummary {
  return {
    start,
    end,
    days_with_data: rows.length,
    days_with_readiness: rows.filter((row) => row.readiness_score != null).length,
    days_with_sleep: rows.filter((row) => row.sleep_hours != null).length,
    days_with_protein: rows.filter((row) => row.protein_g != null).length,
    days_with_hydration: rows.filter((row) => row.hydration_liters != null).length,
    days_with_steps: rows.filter((row) => row.step_count != null).length,
    days_with_body_weight: rows.filter((row) => row.body_weight_kg != null).length,
    avg_readiness: average(rows.map((row) => row.readiness_score)),
    avg_sleep_hours: average(rows.map((row) => row.sleep_hours)),
    avg_sleep_performance: average(rows.map((row) => row.sleep_performance)),
    avg_hrv: average(rows.map((row) => row.hrv)),
    avg_rhr: average(rows.map((row) => row.rhr)),
    avg_whoop_strain: average(rows.map((row) => row.whoop_strain)),
    avg_body_weight_kg: average(rows.map((row) => row.body_weight_kg)),
    avg_active_energy_kcal: average(rows.map((row) => row.active_energy_kcal)),
    avg_resting_energy_kcal: average(rows.map((row) => row.resting_energy_kcal)),
    avg_walking_running_distance_km: average(rows.map((row) => row.walking_running_distance_km)),
    avg_body_fat_pct: average(rows.map((row) => row.body_fat_pct)),
    avg_lean_mass_kg: average(rows.map((row) => row.lean_mass_kg)),
    total_tonal_sessions: rows.reduce((sum, row) => sum + (row.tonal_sessions ?? 0), 0),
    total_tonal_volume: Number(rows.reduce((sum, row) => sum + (row.tonal_volume ?? 0), 0).toFixed(2)),
    avg_protein_g: average(rows.map((row) => row.protein_g)),
    protein_days_on_target: rows.filter((row) => row.protein_g != null && row.protein_target_g != null && row.protein_g >= row.protein_target_g).length,
    avg_hydration_liters: average(rows.map((row) => row.hydration_liters)),
    total_steps: rows.reduce((sum, row) => sum + (row.step_count ?? 0), 0),
    avg_daily_steps: average(rows.map((row) => row.step_count)),
    days_with_recommendation: rows.filter((row) => row.recommendation_mode != null).length,
  };
}

export function trajectory(current: AthleteStateWindowSummary, previous: AthleteStateWindowSummary): Trajectory {
  if (current.days_with_data < 8 || previous.days_with_data < 8) return "unknown";
  const readiness = delta(current.avg_readiness, previous.avg_readiness).delta ?? 0;
  const sleep = delta(current.avg_sleep_hours, previous.avg_sleep_hours).delta ?? 0;
  const strain = delta(current.avg_whoop_strain, previous.avg_whoop_strain).delta ?? 0;
  if (readiness >= 1.5 && sleep >= 0.2 && strain <= 1.5) return "improving";
  if (readiness <= -1.5 || sleep <= -0.2) return "regressing";
  return "stable";
}

export function trajectoryReason(current: AthleteStateWindowSummary, previous: AthleteStateWindowSummary): string {
  if (current.days_with_data < 8) {
    return "insufficient current-month coverage for a stable monthly trend signal";
  }
  if (previous.days_with_data < 8) {
    return "no prior completed-month baseline with sufficient coverage";
  }
  return "trend signal computed from canonical athlete-state rows";
}

export function stepCoverageReason(current: AthleteStateWindowSummary): string | null {
  if (current.days_with_steps > 0) return null;
  if (current.days_with_data === 0) return "no monthly fitness snapshots were captured";
  return "Athlete-state rows exist, but no daily step field was persisted from the provider payload";
}

export function bodyWeightCoverageReason(current: AthleteStateWindowSummary): string | null {
  if (current.days_with_body_weight > 0) return null;
  if (current.days_with_data === 0) return "no monthly fitness snapshots were captured";
  return "Athlete-state rows exist, but no trusted daily body-weight field was persisted from the preferred-source pipeline";
}

function main(): void {
  const explicitAnchor = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]) ? process.argv[2] : null;
  const anchorYmd = explicitAnchor ?? localYmd();
  const windows = explicitAnchor ? monthlyWindows(anchorYmd) : completedMonthlyWindows(anchorYmd);

  const current = buildMonthlyWindowSummaryFromState(
    fetchAthleteStateRows(windows.current.start, windows.current.end),
    windows.current.start,
    windows.current.end,
  );
  const previous = buildMonthlyWindowSummaryFromState(
    fetchAthleteStateRows(windows.previous.start, windows.previous.end),
    windows.previous.start,
    windows.previous.end,
  );
  const currentTrajectory = trajectory(current, previous);
  const currentTrajectoryReason = trajectoryReason(current, previous);
  const currentStepCoverageReason = stepCoverageReason(current);
  const currentBodyWeightCoverageReason = bodyWeightCoverageReason(current);

  const out = {
    generated_at: new Date().toISOString(),
    anchor_date: anchorYmd,
    reporting_mode: explicitAnchor ? "anchor_month" : "most_recent_completed_month",
    source: "db:cortana_fitness_athlete_state_daily",
    month_windows: windows,
    trajectory: currentTrajectory,
    trajectory_reason: currentTrajectoryReason,
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
      body_weight_kg: delta(current.avg_body_weight_kg, previous.avg_body_weight_kg),
      active_energy_kcal: delta(current.avg_active_energy_kcal, previous.avg_active_energy_kcal),
      resting_energy_kcal: delta(current.avg_resting_energy_kcal, previous.avg_resting_energy_kcal),
      walking_running_distance_km: delta(current.avg_walking_running_distance_km, previous.avg_walking_running_distance_km),
    },
    data_quality: {
      days_with_data: current.days_with_data,
      has_minimum_coverage: current.days_with_data >= 14,
      readiness_coverage_days: current.days_with_readiness,
      sleep_coverage_days: current.days_with_sleep,
      hydration_coverage_days: current.days_with_hydration,
      step_coverage_days: current.days_with_steps,
      body_weight_coverage_days: current.days_with_body_weight,
      protein_coverage_days: current.days_with_protein,
      recommendation_coverage_days: current.days_with_recommendation,
      tonal_sessions: current.total_tonal_sessions,
      tonal_volume: current.total_tonal_volume,
    },
    diagnostics: {
      has_whoop_signal: current.days_with_readiness > 0 || current.days_with_sleep > 0 || current.avg_whoop_strain != null,
      has_tonal_signal: current.total_tonal_sessions > 0 || current.total_tonal_volume > 0,
      step_coverage_missing: current.days_with_steps === 0,
      step_coverage_reason: currentStepCoverageReason,
      body_weight_coverage_missing: current.days_with_body_weight === 0,
      body_weight_coverage_reason: currentBodyWeightCoverageReason,
      trajectory_reason: currentTrajectoryReason,
    },
    notes: [
      "Monthly overview uses canonical athlete-state rows only (no live Whoop/Tonal fetches).",
      "Body weight, steps, and energy metrics reflect preferred-source reconciliation when Apple Health rows are available.",
      "Hydration remains null unless provided by meal logs, coach nutrition rows, or future device hydration ingestion.",
    ],
  };

  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
