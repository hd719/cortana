import { loadVacationOpsConfig } from "./vacation-config.js";
import { runVacationChecks, type VacationCheckEnvironment } from "./vacation-checks.js";
import { runRemediationPlan, type RemediationEnvironment } from "./vacation-remediation.js";
import {
  finishVacationRun,
  recordVacationActions,
  recordVacationCheckResults,
  startVacationRun,
  upsertVacationIncident,
} from "./vacation-state.js";
import type {
  Tier2ThresholdClass,
  VacationActionRow,
  VacationCheckResultRow,
  VacationOpsConfig,
  VacationReadinessOutcome,
  VacationRunRow,
} from "./types.js";

export type ReadinessEvaluation = {
  outcome: VacationReadinessOutcome;
  finalResults: VacationCheckResultRow[];
  missingRequiredSystemKeys: string[];
  tier2WarnSystemKeys: string[];
  reasoning: string[];
};

type Tier2Evaluation = {
  warn: boolean;
  reason: string;
};

function statusSeverity(status: VacationCheckResultRow["status"]): number {
  switch (status) {
    case "green":
    case "info":
      return 0;
    case "yellow":
    case "warn":
      return 1;
    case "red":
      return 2;
    case "fail":
    case "skipped":
    default:
      return 3;
  }
}

export function keepFreshestResults(results: VacationCheckResultRow[]): VacationCheckResultRow[] {
  const bySystem = new Map<string, VacationCheckResultRow>();
  for (const result of results) {
    const existing = bySystem.get(result.system_key);
    const currentTs = Date.parse(result.freshness_at ?? result.observed_at);
    const existingTs = existing ? Date.parse(existing.freshness_at ?? existing.observed_at) : 0;
    if (!existing || currentTs >= existingTs) bySystem.set(result.system_key, result);
  }
  return [...bySystem.values()];
}

function evaluateTier2(result: VacationCheckResultRow, config: VacationOpsConfig): Tier2Evaluation {
  const system = config.systems[result.system_key];
  const cls = system.tier2Class as Tier2ThresholdClass | undefined;
  if (!cls) return { warn: false, reason: "no threshold class" };
  if (result.status === "green" || result.status === "info") return { warn: false, reason: "healthy" };

  const detail = result.detail ?? {};
  const consecutiveFailures = Number(detail.consecutiveFailures ?? 0);
  const staleHours = Number(detail.staleHours ?? 0);
  const staleMinutes = Number(detail.staleMinutes ?? 0);
  const marketHours = Boolean(detail.marketHours);
  const rawMinutesBeforeNextOpen = detail.minutesBeforeNextOpen;
  const minutesBeforeNextOpen =
    rawMinutesBeforeNextOpen == null || rawMinutesBeforeNextOpen === ""
      ? Number.POSITIVE_INFINITY
      : Number(rawMinutesBeforeNextOpen);
  if (cls === "market_trading") {
    const thresholds = config.tier2Thresholds.market_trading;
    const warn =
      consecutiveFailures >= thresholds.warnAfterConsecutiveFailures ||
      (marketHours && staleMinutes >= thresholds.warnAfterMinutesMarketHours) ||
      (!marketHours && minutesBeforeNextOpen <= thresholds.warnBeforeNextOpenMinutes);
    return { warn, reason: warn ? "market_trading_threshold" : "market_trading_info_only" };
  }
  if (cls === "fitness_news") {
    const thresholds = config.tier2Thresholds.fitness_news;
    const warn = consecutiveFailures >= thresholds.warnAfterConsecutiveFailures || staleHours >= thresholds.warnAfterStaleHours;
    return { warn, reason: warn ? "fitness_news_threshold" : "fitness_news_info_only" };
  }
  const thresholds = config.tier2Thresholds.background_intel;
  const warn = consecutiveFailures >= thresholds.warnAfterConsecutiveFailures || staleHours >= thresholds.warnAfterStaleHours;
  return { warn, reason: warn ? "background_intel_threshold" : "background_intel_info_only" };
}

export function deriveReadinessOutcome(results: VacationCheckResultRow[], config: VacationOpsConfig): ReadinessEvaluation {
  const finalResults = keepFreshestResults(results);
  const finalByKey = new Map(finalResults.map((result) => [result.system_key, result]));
  const missingRequiredSystemKeys = Object.entries(config.systems)
    .filter(([, def]) => def.required)
    .map(([key]) => key)
    .filter((key) => !finalByKey.has(key));

  const reasoning: string[] = [];

  const tier0Failures = finalResults.filter((result) => config.systems[result.system_key]?.tier === 0 && statusSeverity(result.status) >= 2);
  if (tier0Failures.length) {
    reasoning.push(`tier0_failed=${tier0Failures.map((item) => item.system_key).join(",")}`);
    return { outcome: "no_go", finalResults, missingRequiredSystemKeys, tier2WarnSystemKeys: [], reasoning };
  }

  const tier1Failures = finalResults.filter((result) => config.systems[result.system_key]?.tier === 1 && statusSeverity(result.status) >= 2);
  if (tier1Failures.length) {
    reasoning.push(`tier1_failed=${tier1Failures.map((item) => item.system_key).join(",")}`);
    return { outcome: "no_go", finalResults, missingRequiredSystemKeys, tier2WarnSystemKeys: [], reasoning };
  }

  if (missingRequiredSystemKeys.length) {
    reasoning.push(`missing_required_checks=${missingRequiredSystemKeys.join(",")}`);
    return { outcome: "fail", finalResults, missingRequiredSystemKeys, tier2WarnSystemKeys: [], reasoning };
  }

  const incompleteRequired = finalResults.filter((result) => config.systems[result.system_key]?.required && statusSeverity(result.status) >= 3);
  if (incompleteRequired.length) {
    reasoning.push(`required_incomplete=${incompleteRequired.map((item) => item.system_key).join(",")}`);
    return { outcome: "fail", finalResults, missingRequiredSystemKeys, tier2WarnSystemKeys: [], reasoning };
  }

  const tier2WarnSystemKeys = finalResults
    .filter((result) => config.systems[result.system_key]?.tier === 2)
    .filter((result) => evaluateTier2(result, config).warn)
    .map((result) => result.system_key);

  if (tier2WarnSystemKeys.length) {
    reasoning.push(`tier2_warn=${tier2WarnSystemKeys.join(",")}`);
    return { outcome: "warn", finalResults, missingRequiredSystemKeys, tier2WarnSystemKeys, reasoning };
  }

  reasoning.push("tier0_tier1_green");
  return { outcome: "pass", finalResults, missingRequiredSystemKeys, tier2WarnSystemKeys, reasoning };
}

export function shouldAttemptRemediation(config: VacationOpsConfig, result: VacationCheckResultRow): boolean {
  const system = config.systems[result.system_key];
  if (!system) return false;
  if (![0, 1].includes(system.tier)) return false;
  if (statusSeverity(result.status) < 2) return false;
  return Array.isArray(system.remediation) && system.remediation.length > 0;
}

export function isFreshReadinessRun(run: VacationRunRow | null, freshnessHours: number, now = new Date()): boolean {
  if (!run?.completed_at) return false;
  const outcome = run.readiness_outcome;
  if (!outcome || !["pass", "warn"].includes(outcome)) return false;
  const ageMs = now.getTime() - Date.parse(run.completed_at);
  return ageMs <= freshnessHours * 60 * 60 * 1000;
}

function syncIncidents(windowId: number | null | undefined, runId: number, results: VacationCheckResultRow[], actions: VacationActionRow[]): void {
  if (windowId == null) return;
  const latestActionBySystem = new Map<string, VacationActionRow>();
  for (const action of actions) latestActionBySystem.set(action.system_key, action);

  for (const result of results) {
    const severity = statusSeverity(result.status);
    const latestAction = latestActionBySystem.get(result.system_key);
    if (severity === 0) {
      upsertVacationIncident({
        vacationWindowId: windowId,
        runId,
        latestActionId: null,
        latestCheckResultId: null,
        systemKey: result.system_key,
        tier: result.tier,
        status: "resolved",
        humanRequired: false,
        observedAt: result.freshness_at ?? result.observed_at,
        symptom: "healthy",
        resolutionReason: latestAction ? "remediated" : "healthy",
        detail: result.detail,
      });
      continue;
    }

    upsertVacationIncident({
      vacationWindowId: windowId,
      runId,
      latestActionId: null,
      latestCheckResultId: null,
      systemKey: result.system_key,
      tier: result.tier,
      status: latestAction && latestAction.action_status === "blocked" ? "human_required" : "degraded",
      humanRequired: latestAction?.action_status === "blocked",
      observedAt: result.freshness_at ?? result.observed_at,
      symptom: String(result.detail.reason ?? result.detail.detail ?? result.status),
      detail: {
        result: result.detail,
        latestAction: latestAction?.detail ?? null,
      },
    });
  }
}

export function runVacationReadiness(params: {
  config?: VacationOpsConfig;
  vacationWindowId?: number | null;
  triggerSource?: VacationRunRow["trigger_source"];
  systemKeys?: string[];
  checkEnv?: VacationCheckEnvironment;
  remediationEnv?: RemediationEnvironment;
}): ReadinessEvaluation & { run: VacationRunRow; actions: VacationActionRow[] } {
  const config = params.config ?? loadVacationOpsConfig();
  const run = startVacationRun({
    vacationWindowId: params.vacationWindowId ?? null,
    runType: "readiness",
    triggerSource: params.triggerSource ?? "manual_command",
  });
  try {
    const remediationWindowId = params.vacationWindowId ?? 0;
    const initialResults = runVacationChecks(config, params.checkEnv, params.systemKeys);
    const results = [...initialResults];
    const actions: VacationActionRow[] = [];

    for (const result of initialResults) {
      if (!shouldAttemptRemediation(config, result)) continue;
      const remediation = runRemediationPlan({
        config,
        systemKey: result.system_key,
        initialCheck: result,
        checkRunner: (systemKey) => runVacationChecks(config, params.checkEnv, [systemKey])[0],
        vacationWindowId: remediationWindowId,
        runId: run.id,
        env: params.remediationEnv,
      });
      actions.push(...remediation.actions);
      results.push(remediation.finalCheck);
    }

    recordVacationCheckResults(run.id, results);
    if (actions.length && params.vacationWindowId != null) recordVacationActions(actions);

    const evaluation = deriveReadinessOutcome(results, config);
    syncIncidents(params.vacationWindowId, run.id, evaluation.finalResults, actions);

    const summaryPayload = {
      outcome: evaluation.outcome,
      reasoning: evaluation.reasoning,
      tier2WarnSystemKeys: evaluation.tier2WarnSystemKeys,
      missingRequiredSystemKeys: evaluation.missingRequiredSystemKeys,
    };
    const completedRun = finishVacationRun(run.id, {
      state: evaluation.outcome === "fail" ? "failed" : "completed",
      readinessOutcome: evaluation.outcome,
      summaryPayload,
      summaryText: JSON.stringify(summaryPayload),
    });
    return { ...evaluation, run: completedRun, actions };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishVacationRun(run.id, {
      state: "failed",
      summaryPayload: { error: message },
      summaryText: message,
    });
    throw error;
  }
}
