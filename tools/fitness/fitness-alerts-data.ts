#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import {
  dedupeAlertDecisions,
  evaluateAlertPolicy,
  type AlertDecision,
  type AlertPolicyInput,
  type AlertType,
} from "./alert-policy.js";
import {
  fetchCoachCheckinDaySignals,
  markCoachAlertDelivered,
  upsertCoachAlert,
  type CoachCheckinDaySignals,
} from "./checkin-db.js";

type MorningArtifact = {
  date?: string;
  morning_readiness?: {
    band?: AlertPolicyInput["readinessBand"];
  };
  readiness_signal?: {
    riskFlags?: string[];
  };
  data_freshness?: {
    recovery_hours?: number | null;
    sleep_hours?: number | null;
  };
  today_training_context?: {
    whoop_total_strain_today?: number | null;
    tonal_sessions_today?: number | null;
  };
  today_training_recommendation?: {
    mode?: string;
  };
  today_mission?: {
    mission_key?: string;
    nutrition?: {
      protein_actual_g?: number | null;
      protein_target_g?: number | null;
    };
  };
};

type EveningArtifact = {
  date?: string;
  today_training_output?: {
    whoop?: {
      total_strain_today?: number | null;
    };
    tonal?: {
      sessions_today?: number | null;
    };
    load_signal?: {
      band?: AlertPolicyInput["readinessBand"];
    };
  };
  today_nutrition?: {
    protein_g?: number | null;
    protein_target_g?: {
      min?: number | null;
    };
  };
};

const ALERT_TYPES: AlertType[] = [
  "freshness",
  "recovery_risk",
  "overreach",
  "protein_miss",
  "pain",
  "schedule_conflict",
];

function toObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function parseRequestedAlertTypes(raw: string | null | undefined): AlertType[] {
  if (!raw) return ALERT_TYPES;
  const requested = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is AlertType => ALERT_TYPES.includes(value as AlertType));
  return requested.length > 0 ? requested : ALERT_TYPES;
}

function plannedIntensityFor(mode: string | undefined): AlertPolicyInput["plannedIntensity"] {
  if (mode === "go_hard") return "hard";
  if (mode === "controlled_train") return "moderate";
  if (mode === "zone2_mobility") return "easy";
  if (mode === "rest_and_recover") return "recovery";
  return undefined;
}

export function buildAlertPolicyInput(options: {
  dateLocal: string;
  morningArtifact?: MorningArtifact | null;
  eveningArtifact?: EveningArtifact | null;
  daySignals?: CoachCheckinDaySignals | null;
}): AlertPolicyInput {
  const morning = options.morningArtifact ?? {};
  const evening = options.eveningArtifact ?? {};
  const daySignals = options.daySignals ?? null;

  return {
    dateLocal: options.dateLocal,
    missionKey: morning.today_mission?.mission_key ?? null,
    readinessBand: morning.morning_readiness?.band ?? evening.today_training_output?.load_signal?.band,
    dataFreshnessHours: {
      recovery: numberOrNull(morning.data_freshness?.recovery_hours),
      sleep: numberOrNull(morning.data_freshness?.sleep_hours),
    },
    riskFlags: Array.isArray(morning.readiness_signal?.riskFlags) ? morning.readiness_signal?.riskFlags : [],
    totalStrainToday:
      numberOrNull(morning.today_training_context?.whoop_total_strain_today)
      ?? numberOrNull(evening.today_training_output?.whoop?.total_strain_today),
    tonalSessionsToday:
      numberOrNull(morning.today_training_context?.tonal_sessions_today)
      ?? numberOrNull(evening.today_training_output?.tonal?.sessions_today),
    proteinActualG:
      numberOrNull(morning.today_mission?.nutrition?.protein_actual_g)
      ?? numberOrNull(evening.today_nutrition?.protein_g),
    proteinTargetG:
      numberOrNull(morning.today_mission?.nutrition?.protein_target_g)
      ?? numberOrNull(evening.today_nutrition?.protein_target_g?.min),
    painFlag: daySignals?.pain_flag ?? false,
    sorenessScore: daySignals?.soreness_score ?? null,
    scheduleConstraint: daySignals?.schedule_constraint ?? null,
    plannedIntensity: plannedIntensityFor(morning.today_training_recommendation?.mode),
  };
}

export function selectPrimaryAlert(alerts: AlertDecision[]): AlertDecision | null {
  if (alerts.length === 0) return null;
  const severityRank = (severity: AlertDecision["severity"]): number => (severity === "high" ? 3 : severity === "warning" ? 2 : 1);
  return [...alerts].sort((a, b) => severityRank(b.severity) - severityRank(a.severity))[0] ?? null;
}

function filterAlerts(alerts: AlertDecision[], requestedTypes: AlertType[]): AlertDecision[] {
  const allowed = new Set(requestedTypes);
  return alerts.filter((alert) => allowed.has(alert.alert_type));
}

function runJsonScript(scriptPath: string): Record<string, unknown> {
  const result = spawnSync("npx", ["tsx", scriptPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if ((result.status ?? 1) !== 0) {
    throw new Error((result.stderr || `script failed: ${scriptPath}`).trim());
  }
  const text = String(result.stdout ?? "").trim();
  if (!text) return {};
  try {
    return toObject(JSON.parse(text));
  } catch (error) {
    throw new Error(`invalid_json_from:${scriptPath}:${error instanceof Error ? error.message : String(error)}`);
  }
}

function logAlerts(alerts: AlertDecision[]): Array<{ alert_key: string; ok: boolean; error?: string }> {
  return alerts.map((alert) => {
    const result = upsertCoachAlert({
      alertKey: alert.alert_key,
      tsUtc: new Date().toISOString(),
      alertType: alert.alert_type,
      severity: alert.severity,
      delivered: false,
      context: {
        title: alert.title,
        summary: alert.summary,
        ...alert.context,
      },
    });
    return {
      alert_key: alert.alert_key,
      ok: result.ok,
      error: result.error,
    };
  });
}

function main(): void {
  const markDeliveredArg = process.argv.find((arg) => arg.startsWith("--mark-delivered="));
  if (markDeliveredArg) {
    const alertKey = markDeliveredArg.split("=")[1] ?? "";
    const result = markCoachAlertDelivered(alertKey);
    process.stdout.write(`${JSON.stringify({ ok: result.ok, alert_key: alertKey, error: result.error ?? null })}\n`);
    return;
  }

  const requestedTypes = parseRequestedAlertTypes(
    process.argv.find((arg) => arg.startsWith("--types="))?.split("=")[1] ?? null,
  );
  const needsMorning = requestedTypes.some((type) => type === "freshness" || type === "recovery_risk");
  const needsEvening = requestedTypes.some((type) => type === "overreach" || type === "protein_miss");
  const needsCheckins = requestedTypes.some((type) => type === "pain" || type === "schedule_conflict");

  const errors: string[] = [];
  let morningArtifact: MorningArtifact | null = null;
  let eveningArtifact: EveningArtifact | null = null;

  try {
    if (needsMorning || !needsEvening) {
      morningArtifact = runJsonScript("/Users/hd/Developer/cortana/tools/fitness/morning-brief-data.ts") as MorningArtifact;
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  try {
    if (needsEvening || !needsMorning) {
      eveningArtifact = runJsonScript("/Users/hd/Developer/cortana/tools/fitness/evening-recap-data.ts") as EveningArtifact;
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const dateLocal = String(morningArtifact?.date ?? eveningArtifact?.date ?? "").trim();
  const daySignals = needsCheckins && dateLocal ? fetchCoachCheckinDaySignals(dateLocal) : null;
  const policyInput = buildAlertPolicyInput({
    dateLocal,
    morningArtifact,
    eveningArtifact,
    daySignals,
  });
  const alerts = filterAlerts(dedupeAlertDecisions(evaluateAlertPolicy(policyInput)), requestedTypes);
  const logResults = logAlerts(alerts);
  const primaryAlert = selectPrimaryAlert(alerts);

  process.stdout.write(`${JSON.stringify({
    generated_at: new Date().toISOString(),
    date: dateLocal,
    requested_types: requestedTypes,
    alerts,
    primary_alert: primaryAlert,
    day_signals: daySignals,
    policy_input: policyInput,
    log_results: logResults,
    mark_delivered_command: primaryAlert
      ? `npx tsx /Users/hd/Developer/cortana/tools/fitness/fitness-alerts-data.ts --mark-delivered=${primaryAlert.alert_key}`
      : null,
    errors,
  })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
