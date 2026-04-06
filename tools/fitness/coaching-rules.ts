import type { ReadinessBand } from "./signal-utils.js";

export type MorningRecommendation = {
  mode: "go_hard" | "controlled_train" | "zone2_mobility" | "rest_and_recover";
  rationale: string;
  concrete_action: string;
};

export function whoopRecoveryBandFromScore(score: number | null): ReadinessBand {
  if (score == null || !Number.isFinite(score)) return "unknown";
  if (score >= 67) return "green";
  if (score >= 34) return "yellow";
  return "red";
}

export function readinessEmoji(band: ReadinessBand): string {
  if (band === "green") return "🟢";
  if (band === "yellow") return "🟡";
  if (band === "red") return "🔴";
  return "⚪";
}

export function buildMorningTrainingRecommendation(opts: {
  readinessBand: ReadinessBand;
  sleepPerformance: number | null;
  isStale: boolean;
}): MorningRecommendation {
  if (opts.isStale || opts.readinessBand === "unknown") {
    return {
      mode: "zone2_mobility",
      rationale: "Data freshness is weak, so avoid high-intensity risk.",
      concrete_action: "Do 30-45 min Zone 2 plus 10 min mobility; reassess once fresh recovery data lands.",
    };
  }
  if (opts.readinessBand === "red") {
    return {
      mode: "rest_and_recover",
      rationale: "Whoop readiness is red, so adaptation odds are low for hard work.",
      concrete_action: "Skip heavy lifting and intervals; prioritize recovery work only.",
    };
  }
  if (opts.readinessBand === "yellow" || (opts.sleepPerformance ?? 100) < 80) {
    return {
      mode: "controlled_train",
      rationale: "Moderate readiness supports training only with controlled intensity.",
      concrete_action: "Run a controlled session: quality lifts or Zone 2, no max-effort sets.",
    };
  }
  return {
    mode: "go_hard",
    rationale: "Readiness and sleep quality support a progressive session.",
    concrete_action: "Run the planned hard session, but stop when rep quality drops.",
  };
}
