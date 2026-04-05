import type { AthleteStatePhaseMode } from "./athlete-state-db.js";
import { resolveSpartanPhaseDefaults } from "./spartan-defaults.js";

export type GoalModeStatus = "on_pace" | "too_fast" | "too_slow" | "holding" | "drifting" | "unknown";

export type GoalModeAssessment = {
  phaseMode: AthleteStatePhaseMode;
  targetWeightDeltaPctWeek: number | null;
  actualWeightDeltaPctWeek: number | null;
  confidence: number;
  status: GoalModeStatus;
  rationale: string;
};

function abs(value: number | null): number {
  return Math.abs(value ?? 0);
}

export function assessGoalModeProgress(input: {
  phaseMode: AthleteStatePhaseMode;
  actualWeightDeltaPctWeek: number | null;
  confidence: number | null;
}): GoalModeAssessment {
  const phaseMode = input.phaseMode;
  const confidence = Math.max(0, Math.min(0.98, input.confidence ?? 0));

  if (phaseMode === "unknown" || input.actualWeightDeltaPctWeek == null || confidence < 0.45) {
    return {
      phaseMode,
      targetWeightDeltaPctWeek: phaseMode === "unknown" ? null : resolveSpartanPhaseDefaults(phaseMode).targetWeightDeltaPctPerWeek,
      actualWeightDeltaPctWeek: input.actualWeightDeltaPctWeek,
      confidence,
      status: "unknown",
      rationale: "Weight-trend confidence is too low to call cut, maintenance, or gain pace.",
    };
  }

  const target = resolveSpartanPhaseDefaults(phaseMode).targetWeightDeltaPctPerWeek;
  const actual = input.actualWeightDeltaPctWeek;

  if (phaseMode === "maintenance") {
    const status = abs(actual) <= 0.2 ? "holding" : "drifting";
    return {
      phaseMode,
      targetWeightDeltaPctWeek: target,
      actualWeightDeltaPctWeek: actual,
      confidence,
      status,
      rationale: status === "holding"
        ? "Body weight is staying effectively flat, which matches maintenance."
        : "Body weight is drifting enough to move maintenance off target.",
    };
  }

  const deltaFromTarget = actual - target;
  const tolerance = phaseMode === "lean_gain" ? 0.15 : 0.2;
  let status: GoalModeStatus = "on_pace";
  if (phaseMode === "lean_gain") {
    if (deltaFromTarget < -tolerance) status = "too_slow";
    if (deltaFromTarget > tolerance) status = "too_fast";
  } else {
    if (actual > target + tolerance) status = "too_slow";
    if (actual < target - tolerance) status = "too_fast";
  }

  const rationale = status === "on_pace"
    ? "Actual weekly weight change is aligned with the current phase target."
    : status === "too_fast"
      ? "Weight is moving faster than the target pace and raises body-composition or recovery risk."
      : "Weight is moving slower than the target pace, so the phase is not progressing as intended.";

  return {
    phaseMode,
    targetWeightDeltaPctWeek: target,
    actualWeightDeltaPctWeek: actual,
    confidence,
    status,
    rationale,
  };
}
