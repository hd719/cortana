export type FitnessProviderStatus = "ok" | "degraded" | "missing";

export type FitnessContextInput = {
  today: string;
  generatedAt: string;
  whoop?: {
    recoveryScore?: number | null;
    sleepPerformance?: number | null;
    workoutsToday?: unknown[];
    stale?: boolean;
  } | null;
  tonal?: {
    healthy?: boolean;
    workoutsToday?: unknown[];
    volumeToday?: number | null;
  } | null;
  nutrition?: {
    proteinGrams?: number | null;
    loggedMeals?: number;
  } | null;
};

export type FitnessContext = {
  today: string;
  generated_at: string;
  readiness: {
    band: "green" | "yellow" | "red" | "unknown";
    score: number | null;
    stale: boolean;
  };
  sleep: {
    performance: number | null;
  };
  training: {
    tonal_healthy: boolean;
    tonal_sessions_today: number;
    tonal_volume_today: number | null;
    whoop_workouts_today: number;
  };
  nutrition: {
    protein_grams: number | null;
    logged_meals: number;
  };
  quality: {
    status: FitnessProviderStatus;
    errors: string[];
  };
};

function readinessBand(score: number | null | undefined): FitnessContext["readiness"]["band"] {
  if (typeof score !== "number" || !Number.isFinite(score)) return "unknown";
  if (score >= 67) return "green";
  if (score >= 34) return "yellow";
  return "red";
}

export function buildFitnessContext(input: FitnessContextInput): FitnessContext {
  const errors: string[] = [];
  const recoveryScore = typeof input.whoop?.recoveryScore === "number" ? input.whoop.recoveryScore : null;
  const sleepPerformance = typeof input.whoop?.sleepPerformance === "number" ? input.whoop.sleepPerformance : null;
  const tonalHealthy = input.tonal?.healthy === true;

  if (!input.whoop) errors.push("whoop_missing");
  if (input.whoop?.stale) errors.push("whoop_stale");
  if (recoveryScore === null) errors.push("whoop_recovery_missing");
  if (!input.tonal) errors.push("tonal_missing");
  if (input.tonal && !tonalHealthy) errors.push("tonal_not_healthy");

  const status: FitnessProviderStatus = errors.length ? (errors.includes("whoop_missing") && errors.includes("tonal_missing") ? "missing" : "degraded") : "ok";

  return {
    today: input.today,
    generated_at: input.generatedAt,
    readiness: {
      band: readinessBand(recoveryScore),
      score: recoveryScore,
      stale: input.whoop?.stale === true,
    },
    sleep: { performance: sleepPerformance },
    training: {
      tonal_healthy: tonalHealthy,
      tonal_sessions_today: tonalHealthy && Array.isArray(input.tonal?.workoutsToday) ? input.tonal.workoutsToday.length : 0,
      tonal_volume_today: tonalHealthy && typeof input.tonal?.volumeToday === "number" ? input.tonal.volumeToday : null,
      whoop_workouts_today: Array.isArray(input.whoop?.workoutsToday) ? input.whoop.workoutsToday.length : 0,
    },
    nutrition: {
      protein_grams: typeof input.nutrition?.proteinGrams === "number" ? input.nutrition.proteinGrams : null,
      logged_meals: Number(input.nutrition?.loggedMeals ?? 0),
    },
    quality: { status, errors },
  };
}
