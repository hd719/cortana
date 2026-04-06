import { createHash } from "node:crypto";
import type { ReadinessBand } from "./signal-utils.js";

export type AlertSeverity = "info" | "warning" | "high";
export type AlertType =
  | "freshness"
  | "recovery_risk"
  | "overreach"
  | "protein_miss"
  | "pain"
  | "schedule_conflict";

export type AlertContext = Record<string, unknown>;

export type AlertDecision = {
  alert_key: string;
  alert_type: AlertType;
  severity: AlertSeverity;
  title: string;
  summary: string;
  context: AlertContext;
  should_deliver: boolean;
};

export type AlertPolicyInput = {
  dateLocal: string;
  missionKey?: string | null;
  readinessBand?: ReadinessBand;
  dataFreshnessHours?: {
    recovery?: number | null;
    sleep?: number | null;
  };
  riskFlags?: string[];
  totalStrainToday?: number | null;
  tonalSessionsToday?: number | null;
  proteinActualG?: number | null;
  proteinTargetG?: number | null;
  painFlag?: boolean;
  sorenessScore?: number | null;
  scheduleConstraint?: string | null;
  plannedIntensity?: "hard" | "moderate" | "easy" | "recovery";
};

function severityRank(severity: AlertSeverity): number {
  if (severity === "high") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, stableValue(child)]);
  return Object.fromEntries(entries);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function hashContext(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

export function buildAlertKey(input: {
  alertType: AlertType;
  dateLocal: string;
  scope?: string | null;
  context?: AlertContext;
}): string {
  return `spartan:${input.alertType}:${input.dateLocal}:${hashContext({
    scope: input.scope ?? "daily",
    context: input.context ?? {},
  })}`;
}

function createDecision(input: {
  alertType: AlertType;
  dateLocal: string;
  severity: AlertSeverity;
  title: string;
  summary: string;
  context?: AlertContext;
  scope?: string | null;
}): AlertDecision {
  return {
    alert_key: buildAlertKey({
      alertType: input.alertType,
      dateLocal: input.dateLocal,
      scope: input.scope ?? input.alertType,
      context: input.context ?? {},
    }),
    alert_type: input.alertType,
    severity: input.severity,
    title: input.title,
    summary: input.summary,
    context: input.context ?? {},
    should_deliver: true,
  };
}

function maxSeverity(a: AlertSeverity, b: AlertSeverity): AlertSeverity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

function shouldFlagFreshness(hours: number | null | undefined): boolean {
  return hours != null && hours > 18;
}

function recoveryRiskSeverity(readinessBand: ReadinessBand | undefined, riskFlags: string[]): AlertSeverity | null {
  if (readinessBand === "red") return "high";
  if (riskFlags.includes("low_recovery") || riskFlags.includes("hrv_down_vs_baseline") || riskFlags.includes("rhr_up_vs_baseline")) {
    return riskFlags.length > 1 ? "high" : "warning";
  }
  return null;
}

function overreachSeverity(totalStrainToday: number | null | undefined, readinessBand: ReadinessBand | undefined, tonalSessionsToday: number | null | undefined): AlertSeverity | null {
  const strain = totalStrainToday ?? 0;
  const sessions = tonalSessionsToday ?? 0;
  if (strain >= 18 || (readinessBand === "red" && strain >= 12) || (sessions >= 2 && strain >= 14)) return "high";
  if (strain >= 14 || sessions >= 2 || (readinessBand === "yellow" && strain >= 12)) return "warning";
  return null;
}

function proteinSeverity(proteinActualG: number | null | undefined, proteinTargetG: number | null | undefined, totalStrainToday: number | null | undefined): AlertSeverity | null {
  const target = proteinTargetG ?? 0;
  if (target <= 0) return null;
  if (proteinActualG == null) {
    return (totalStrainToday ?? 0) >= 10 ? "warning" : null;
  }
  const ratio = proteinActualG / target;
  if (ratio < 0.7) return "high";
  if (ratio < 0.85) return "warning";
  return null;
}

function painSeverity(painFlag: boolean | undefined, sorenessScore: number | null | undefined): AlertSeverity | null {
  if (painFlag) return "high";
  if (sorenessScore == null) return null;
  if (sorenessScore >= 8) return "high";
  if (sorenessScore >= 6) return "warning";
  return null;
}

function scheduleSeverity(scheduleConstraint: string | null | undefined, plannedIntensity: AlertPolicyInput["plannedIntensity"], totalStrainToday: number | null | undefined): AlertSeverity | null {
  if (!scheduleConstraint) return null;
  if (plannedIntensity === "hard" || ((totalStrainToday ?? 0) >= 14 && plannedIntensity !== "recovery")) return "warning";
  return "info";
}

export function evaluateAlertPolicy(input: AlertPolicyInput): AlertDecision[] {
  const alerts: AlertDecision[] = [];
  const riskFlags = input.riskFlags ?? [];
  const freshnessRecovery = input.dataFreshnessHours?.recovery ?? null;
  const freshnessSleep = input.dataFreshnessHours?.sleep ?? null;

  if (shouldFlagFreshness(freshnessRecovery) || shouldFlagFreshness(freshnessSleep)) {
    const severity =
      shouldFlagFreshness(freshnessRecovery) && shouldFlagFreshness(freshnessSleep)
        ? "high"
        : "warning";
    alerts.push(
      createDecision({
        alertType: "freshness",
        dateLocal: input.dateLocal,
        severity,
        title: "Freshness degraded",
        summary: "Recovery or sleep data is stale enough that the day should be treated conservatively.",
        context: {
          recovery_hours: freshnessRecovery,
          sleep_hours: freshnessSleep,
          mission_key: input.missionKey ?? null,
        },
      }),
    );
  }

  const recoverySeverity = recoveryRiskSeverity(input.readinessBand, riskFlags);
  if (recoverySeverity) {
    alerts.push(
      createDecision({
        alertType: "recovery_risk",
        dateLocal: input.dateLocal,
        severity: recoverySeverity,
        title: "Recovery risk elevated",
        summary: "Readiness or baseline deltas indicate the body is not ready for unnecessary intensity.",
        context: {
          readiness_band: input.readinessBand ?? null,
          risk_flags: riskFlags,
          mission_key: input.missionKey ?? null,
        },
      }),
    );
  }

  const overreach = overreachSeverity(input.totalStrainToday, input.readinessBand, input.tonalSessionsToday);
  if (overreach) {
    alerts.push(
      createDecision({
        alertType: "overreach",
        dateLocal: input.dateLocal,
        severity: overreach,
        title: "Overreach risk",
        summary: "Training load is high enough that execution quality and recovery protection matter more than extra volume.",
        context: {
          total_strain_today: input.totalStrainToday ?? null,
          tonal_sessions_today: input.tonalSessionsToday ?? null,
          readiness_band: input.readinessBand ?? null,
        },
      }),
    );
  }

  const protein = proteinSeverity(input.proteinActualG, input.proteinTargetG, input.totalStrainToday);
  if (protein) {
    alerts.push(
      createDecision({
        alertType: "protein_miss",
        dateLocal: input.dateLocal,
        severity: protein,
        title: "Protein gap",
        summary: input.proteinActualG == null
          ? "Protein intake was not logged on a day where fueling matters."
          : "Protein intake is below the target band needed to support the current load.",
        context: {
          protein_actual_g: input.proteinActualG ?? null,
          protein_target_g: input.proteinTargetG ?? null,
          total_strain_today: input.totalStrainToday ?? null,
        },
      }),
    );
  }

  const pain = painSeverity(input.painFlag, input.sorenessScore);
  if (pain) {
    alerts.push(
      createDecision({
        alertType: "pain",
        dateLocal: input.dateLocal,
        severity: pain,
        title: "Pain or soreness flag",
        summary: input.painFlag
          ? "Pain language should override aggressive progression."
          : "Soreness is high enough to justify caution and a simpler plan.",
        context: {
          pain_flag: Boolean(input.painFlag),
          soreness_score: input.sorenessScore ?? null,
        },
      }),
    );
  }

  const schedule = scheduleSeverity(input.scheduleConstraint, input.plannedIntensity, input.totalStrainToday);
  if (schedule) {
    alerts.push(
      createDecision({
        alertType: "schedule_conflict",
        dateLocal: input.dateLocal,
        severity: schedule,
        title: "Schedule conflict",
        summary: "The available window does not cleanly support the planned training demand.",
        context: {
          schedule_constraint: input.scheduleConstraint ?? null,
          planned_intensity: input.plannedIntensity ?? null,
        },
      }),
    );
  }

  return alerts.sort((a, b) => {
    const typeOrder = ["freshness", "recovery_risk", "overreach", "protein_miss", "pain", "schedule_conflict"];
    const typeDelta = typeOrder.indexOf(a.alert_type) - typeOrder.indexOf(b.alert_type);
    if (typeDelta !== 0) return typeDelta;
    return severityRank(b.severity) - severityRank(a.severity);
  });
}

export function dedupeAlertDecisions(alerts: AlertDecision[]): AlertDecision[] {
  const byKey = new Map<string, AlertDecision>();
  for (const alert of alerts) {
    const existing = byKey.get(alert.alert_key);
    if (!existing) {
      byKey.set(alert.alert_key, alert);
      continue;
    }
    byKey.set(alert.alert_key, {
      ...existing,
      severity: maxSeverity(existing.severity, alert.severity),
      should_deliver: existing.should_deliver || alert.should_deliver,
      context: {
        ...existing.context,
        ...alert.context,
      },
    });
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const typeOrder = ["freshness", "recovery_risk", "overreach", "protein_miss", "pain", "schedule_conflict"];
    const typeDelta = typeOrder.indexOf(a.alert_type) - typeOrder.indexOf(b.alert_type);
    if (typeDelta !== 0) return typeDelta;
    return severityRank(b.severity) - severityRank(a.severity);
  });
}
