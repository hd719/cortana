import type { AppleHealthServiceStatus } from "./health-source-service.js";
import type { ReadinessBand } from "./signal-utils.js";

export type ReliabilityGuardrailStatus = "ok" | "warn" | "block";
export type ReliabilityGuardrailModeCap = "push" | "controlled_train" | "recover";
export type ReliabilityGuardrailReasonSeverity = "warn" | "block";
export type ReliabilityGuardrailReasonImpact = "mode" | "confidence";

export type ReliabilityGuardrailReasonCode =
  | "whoop_recovery_missing"
  | "whoop_sleep_missing"
  | "whoop_recovery_stale"
  | "whoop_sleep_stale"
  | "tonal_unhealthy"
  | "readiness_blind_spot"
  | "nutrition_incomplete"
  | "apple_health_degraded"
  | "apple_health_unhealthy"
  | "apple_health_unconfigured";

export type ReliabilityGuardrailReason = {
  code: ReliabilityGuardrailReasonCode;
  severity: ReliabilityGuardrailReasonSeverity;
  impact: ReliabilityGuardrailReasonImpact;
  message: string;
};

export type MorningReliabilityGuardrailInput = {
  hasRecovery: boolean;
  hasSleep: boolean;
  recoveryFreshnessHours: number | null;
  sleepFreshnessHours: number | null;
  readinessBand: ReadinessBand | null | undefined;
  sleepPerformance: number | null;
  tonalHealthy: boolean;
  appleHealthStatus: AppleHealthServiceStatus | null | undefined;
  proteinTargetG: number | null;
  proteinActualG: number | null;
};

export type MorningReliabilityGuardrail = {
  status: ReliabilityGuardrailStatus;
  modeCap: ReliabilityGuardrailModeCap;
  confidenceCap: number | null;
  blocksPush: boolean;
  reasons: ReliabilityGuardrailReason[];
  summary: string;
};

const WARN_FRESHNESS_HOURS = 18;
const BLOCK_FRESHNESS_HOURS = 30;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function modeRank(mode: ReliabilityGuardrailModeCap): number {
  if (mode === "recover") return 0;
  if (mode === "controlled_train") return 1;
  return 2;
}

function summarizeGuardrail(
  status: ReliabilityGuardrailStatus,
  reasons: ReliabilityGuardrailReason[],
): string {
  if (reasons.length === 0) return "Core morning signals are fresh enough for a normal recommendation.";
  const modeReasons = reasons.filter((reason) => reason.impact === "mode");
  const primary = (modeReasons[0] ?? reasons[0])?.message ?? "Core morning signals need a conservative interpretation.";
  if (status === "block") return `${primary} Spartan should fall back instead of pretending certainty.`;
  if (status === "warn") return `${primary} Spartan should avoid aggressive progression this morning.`;
  return primary;
}

function dedupeReasons(reasons: ReliabilityGuardrailReason[]): ReliabilityGuardrailReason[] {
  const seen = new Set<ReliabilityGuardrailReasonCode>();
  const deduped: ReliabilityGuardrailReason[] = [];
  for (const reason of reasons) {
    if (seen.has(reason.code)) continue;
    seen.add(reason.code);
    deduped.push(reason);
  }
  return deduped;
}

export function buildReliabilityGuardrailErrorCodes(guardrail: MorningReliabilityGuardrail): string[] {
  if (guardrail.status === "ok") return [];
  const codes = [`status_${guardrail.status}`];
  for (const reason of guardrail.reasons) {
    if (reason.impact !== "mode") continue;
    codes.push(reason.code);
  }
  return codes;
}

export function evaluateMorningReliabilityGuardrail(
  input: MorningReliabilityGuardrailInput,
): MorningReliabilityGuardrail {
  const reasons: ReliabilityGuardrailReason[] = [];

  if (!input.hasRecovery) {
    reasons.push({
      code: "whoop_recovery_missing",
      severity: "block",
      impact: "mode",
      message: "WHOOP recovery is missing, so readiness cannot be trusted.",
    });
  } else if ((input.recoveryFreshnessHours ?? 0) > BLOCK_FRESHNESS_HOURS) {
    reasons.push({
      code: "whoop_recovery_stale",
      severity: "block",
      impact: "mode",
      message: "WHOOP recovery is too stale for an aggressive training call.",
    });
  } else if ((input.recoveryFreshnessHours ?? 0) > WARN_FRESHNESS_HOURS) {
    reasons.push({
      code: "whoop_recovery_stale",
      severity: "warn",
      impact: "mode",
      message: "WHOOP recovery is aging out and should be treated conservatively.",
    });
  }

  if (!input.hasSleep) {
    reasons.push({
      code: "whoop_sleep_missing",
      severity: "block",
      impact: "mode",
      message: "WHOOP sleep is missing, so the morning recovery picture is incomplete.",
    });
  } else if ((input.sleepFreshnessHours ?? 0) > BLOCK_FRESHNESS_HOURS) {
    reasons.push({
      code: "whoop_sleep_stale",
      severity: "block",
      impact: "mode",
      message: "WHOOP sleep is too stale for a confident training push.",
    });
  } else if ((input.sleepFreshnessHours ?? 0) > WARN_FRESHNESS_HOURS) {
    reasons.push({
      code: "whoop_sleep_stale",
      severity: "warn",
      impact: "mode",
      message: "WHOOP sleep freshness is degraded enough to lower training ambition.",
    });
  }

  if (!input.tonalHealthy) {
    reasons.push({
      code: "tonal_unhealthy",
      severity: "warn",
      impact: "mode",
      message: "Tonal is unavailable, so Spartan should avoid a push recommendation that depends on live machine state.",
    });
  }

  if (
    (input.readinessBand == null || input.readinessBand === "unknown")
    && input.sleepPerformance == null
    && !input.tonalHealthy
  ) {
    reasons.push({
      code: "readiness_blind_spot",
      severity: "block",
      impact: "mode",
      message: "Readiness is effectively blind because recovery, sleep quality, and Tonal health are all weak at once.",
    });
  }

  if (input.proteinTargetG == null || input.proteinActualG == null) {
    reasons.push({
      code: "nutrition_incomplete",
      severity: "warn",
      impact: "confidence",
      message: "Nutrition logging is incomplete, so the recommendation confidence should stay capped.",
    });
  }

  if (input.appleHealthStatus === "degraded") {
    reasons.push({
      code: "apple_health_degraded",
      severity: "warn",
      impact: "confidence",
      message: "Apple Health is degraded, so body-composition confidence should stay lower today.",
    });
  } else if (input.appleHealthStatus === "unhealthy") {
    reasons.push({
      code: "apple_health_unhealthy",
      severity: "warn",
      impact: "confidence",
      message: "Apple Health is unhealthy, so body-composition metrics are not trustworthy today.",
    });
  } else if (input.appleHealthStatus === "unconfigured") {
    reasons.push({
      code: "apple_health_unconfigured",
      severity: "warn",
      impact: "confidence",
      message: "Apple Health is not configured, so body-composition guidance remains lower confidence.",
    });
  }

  const dedupedReasons = dedupeReasons(reasons);
  const modeReasons = dedupedReasons.filter((reason) => reason.impact === "mode");
  const status: ReliabilityGuardrailStatus = modeReasons.some((reason) => reason.severity === "block")
    ? "block"
    : modeReasons.some((reason) => reason.severity === "warn")
      ? "warn"
      : "ok";

  let modeCap: ReliabilityGuardrailModeCap = "push";
  for (const reason of modeReasons) {
    const reasonCap =
      reason.code === "readiness_blind_spot" || (!input.hasRecovery && !input.hasSleep)
        ? "recover"
        : "controlled_train";
    if (modeRank(reasonCap) < modeRank(modeCap)) modeCap = reasonCap;
  }

  let confidenceCap: number | null = null;
  if (status === "warn") confidenceCap = 0.72;
  if (status === "block") confidenceCap = 0.58;
  for (const reason of dedupedReasons) {
    if (reason.impact !== "confidence") continue;
    const advisoryCap =
      reason.code === "nutrition_incomplete"
        ? 0.74
        : reason.code === "apple_health_unhealthy"
          ? 0.78
          : reason.code === "apple_health_degraded"
            ? 0.82
            : 0.86;
    confidenceCap = confidenceCap == null ? advisoryCap : Math.min(confidenceCap, advisoryCap);
  }
  if (confidenceCap != null) confidenceCap = clamp(confidenceCap, 0.2, 0.95);

  return {
    status,
    modeCap,
    confidenceCap,
    blocksPush: status !== "ok",
    reasons: dedupedReasons,
    summary: summarizeGuardrail(status, dedupedReasons),
  };
}
