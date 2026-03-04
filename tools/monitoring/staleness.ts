export type StalenessBanner = {
  stale: boolean;
  ageMs: number;
  severity: "fresh" | "warning" | "critical";
  message: string;
};

export function computeStalenessBanner(
  refreshedAtIso: string | null | undefined,
  now = new Date(),
  opts?: { warningMs?: number; criticalMs?: number }
): StalenessBanner {
  const warningMs = opts?.warningMs ?? 5 * 60_000;
  const criticalMs = opts?.criticalMs ?? 15 * 60_000;

  const refreshedAt = refreshedAtIso ? new Date(refreshedAtIso) : null;
  const ageMs = refreshedAt && !Number.isNaN(refreshedAt.valueOf()) ? Math.max(0, now.valueOf() - refreshedAt.valueOf()) : Number.POSITIVE_INFINITY;

  if (!Number.isFinite(ageMs) || ageMs >= criticalMs) {
    return {
      stale: true,
      ageMs,
      severity: "critical",
      message: "Data may be stale. Refresh age exceeds critical threshold.",
    };
  }

  if (ageMs >= warningMs) {
    return {
      stale: true,
      ageMs,
      severity: "warning",
      message: "Data is aging. Refresh recommended.",
    };
  }

  return {
    stale: false,
    ageMs,
    severity: "fresh",
    message: "Data freshness healthy.",
  };
}
