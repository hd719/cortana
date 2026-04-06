import { localYmd } from "./signal-utils.js";

export type CoachCheckinType = "midday" | "post_workout" | "evening" | "ad_hoc";

export type CoachComplianceStatus = "completed" | "missed" | "pending" | "unknown";

export type CoachCheckinParse = {
  rawText: string;
  checkinType: CoachCheckinType;
  complianceStatus: CoachComplianceStatus;
  completed: boolean;
  missed: boolean;
  sorenessScore: number | null;
  painFlag: boolean;
  motivationScore: number | null;
  scheduleConstraints: string[];
  scheduleConstraint: string | null;
  explicitSignalCount: number;
  confidence: "high" | "medium" | "low";
  matchedSignals: string[];
};

type ParseOptions = {
  timestampUtc?: string | null;
  timeZone?: string;
};

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(10, Number(value.toFixed(2))));
}

function firstNumericScore(text: string, patterns: RegExp[]): number | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const parsed = Number.parseFloat(match[1]);
    if (Number.isFinite(parsed)) return clampScore(parsed);
  }
  return null;
}

function localHour(timestampUtc: string | null | undefined, timeZone: string): number | null {
  if (!timestampUtc) return null;
  const date = new Date(timestampUtc);
  if (Number.isNaN(date.getTime())) return null;
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).format(date);
  const parsed = Number.parseInt(hour, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function containsAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function extractScheduleConstraints(text: string): string[] {
  const constraints: string[] = [];
  const register = (label: string, patterns: RegExp[]): void => {
    if (containsAny(text, patterns) && !constraints.includes(label)) constraints.push(label);
  };

  register("short_session", [
    /\bshort session\b/,
    /\bshort workout\b/,
    /\b30\s*(?:min|mins|minutes)\b/,
    /\bhalf hour\b/,
    /\bquick session\b/,
    /\btime crunch\b/,
    /\btight on time\b/,
    /\blimited time\b/,
  ]);
  register("travel", [
    /\btravel(?:ing|led)?\b/,
    /\bon the road\b/,
    /\bairport\b/,
    /\bflight\b/,
    /\broad trip\b/,
    /\bhotel gym\b/,
  ]);
  register("late_meeting", [
    /\blate meeting\b/,
    /\bback[- ]to[- ]back meetings?\b/,
    /\bpacked schedule\b/,
    /\bwork late\b/,
    /\blate work\b/,
    /\bafter work\b/,
  ]);
  register("family_commitment", [
    /\bfamily\b/,
    /\bkids?\b/,
    /\bchildcare\b/,
    /\bschool pickup\b/,
    /\bparent pickup\b/,
    /\bbedtime\b/,
  ]);
  register("recovery_day", [
    /\brecovery day\b/,
    /\brest day\b/,
    /\btake it easy\b/,
    /\blight day\b/,
    /\bdeload\b/,
  ]);
  register("equipment_limited", [
    /\blimited equipment\b/,
    /\bno equipment\b/,
    /\btravel gym\b/,
    /\bno tonal\b/,
    /\bno gym\b/,
    /\bhotel room\b/,
  ]);
  register("illness", [
    /\bsick\b/,
    /\bunder the weather\b/,
    /\bflu\b/,
    /\bfever\b/,
    /\bcold\b/,
  ]);

  return constraints;
}

function parsePainFlag(text: string): { painFlag: boolean; explicit: boolean; matchedSignals: string[] } {
  const negativePatterns = [/\bno pain\b/, /\bpain[- ]?free\b/, /\bwithout pain\b/];
  if (containsAny(text, negativePatterns)) return { painFlag: false, explicit: false, matchedSignals: [] };

  const positivePatterns = [
    /\bpain\b/,
    /\bhurt(?:ing|s)?\b/,
    /\bach(?:ing|es|y)?\b/,
    /\binjury\b/,
    /\bstrained?\b/,
    /\btweak(?:ed|ing)?\b/,
    /\btwinge\b/,
    /\bnumb\b/,
    /\bswollen\b/,
    /\btender\b/,
  ];
  if (!containsAny(text, positivePatterns)) return { painFlag: false, explicit: false, matchedSignals: [] };
  return { painFlag: true, explicit: true, matchedSignals: ["pain_flag"] };
}

function parseCompliance(text: string): {
  status: CoachComplianceStatus;
  matchedSignals: string[];
  explicit: boolean;
} {
  const missedPatterns = [
    /\bmissed\b/,
    /\bskipped\b/,
    /\bskip(?:ped)?\b/,
    /\bdid(?:n't| not)\b/,
    /\bcould(?:n't| not)\b/,
    /\bwas(?:n't| not) able\b/,
    /\bran out of time\b/,
    /\bno time\b/,
    /\bnot happening\b/,
  ];
  if (containsAny(text, missedPatterns)) {
    return { status: "missed", matchedSignals: ["compliance_missed"], explicit: true };
  }

  const completedPatterns = [
    /\bdone\b/,
    /\bcompleted\b/,
    /\bfinished\b/,
    /\bwrapped up\b/,
    /\bgot it in\b/,
    /\blogged it\b/,
    /\bnailed it\b/,
    /\bexecuted\b/,
    /\bdid it\b/,
    /\btrained\b/,
  ];
  if (containsAny(text, completedPatterns)) {
    return { status: "completed", matchedSignals: ["compliance_completed"], explicit: true };
  }

  const pendingPatterns = [
    /\bnot yet\b/,
    /\blater\b/,
    /\bsoon\b/,
    /\bwill\b/,
    /\bplanning to\b/,
    /\bgoing to\b/,
    /\bin a bit\b/,
    /\btonight\b/,
  ];
  if (containsAny(text, pendingPatterns)) {
    return { status: "pending", matchedSignals: ["compliance_pending"], explicit: true };
  }

  return { status: "unknown", matchedSignals: [], explicit: false };
}

function parseSoreness(text: string): { score: number | null; explicit: boolean; matchedSignals: string[] } {
  const numericPatterns = [
    /\bsoreness?\s*(?:is|was|at|=|:)?\s*(\d{1,2}(?:\.\d+)?)\s*(?:\/\s*10|out of\s*10|of\s*10)?\b/,
    /\bsore(?:ness)?\s*(?:is|was|at|=|:)?\s*(\d{1,2}(?:\.\d+)?)\s*(?:\/\s*10|out of\s*10|of\s*10)?\b/,
    /\b(\d{1,2}(?:\.\d+)?)\s*(?:\/\s*10|out of\s*10|of\s*10)\s*(?:sore|soreness)?\b/,
  ];
  const numeric = firstNumericScore(text, numericPatterns);
  if (numeric != null) return { score: numeric, explicit: true, matchedSignals: ["soreness_numeric"] };

  const severePatterns = [/\bdestroyed\b/, /\bwrecked\b/, /\bsmoked\b/, /\bcrippled\b/, /\bvery sore\b/, /\bsuper sore\b/];
  if (containsAny(text, severePatterns)) return { score: 8, explicit: true, matchedSignals: ["soreness_high"] };

  const moderatePatterns = [/\bpretty sore\b/, /\bquite sore\b/, /\bmoderately sore\b/, /\bstiff\b/, /\btight\b/];
  if (containsAny(text, moderatePatterns)) return { score: 5, explicit: true, matchedSignals: ["soreness_moderate"] };

  const mildPatterns = [/\ba little sore\b/, /\bslightly sore\b/, /\bmild(?:ly)? sore\b/, /\bminor soreness\b/];
  if (containsAny(text, mildPatterns)) return { score: 3, explicit: true, matchedSignals: ["soreness_mild"] };

  return { score: null, explicit: false, matchedSignals: [] };
}

function parseMotivation(text: string): { score: number | null; explicit: boolean; matchedSignals: string[] } {
  const numericPatterns = [
    /\bmotivation\s*(?:is|was|at|=|:)?\s*(\d{1,2}(?:\.\d+)?)\s*(?:\/\s*10|out of\s*10|of\s*10)?\b/,
    /\benergy\s*(?:is|was|at|=|:)?\s*(\d{1,2}(?:\.\d+)?)\s*(?:\/\s*10|out of\s*10|of\s*10)?\b/,
  ];
  const numeric = firstNumericScore(text, numericPatterns);
  if (numeric != null) return { score: numeric, explicit: true, matchedSignals: ["motivation_numeric"] };

  const lowPatterns = [
    /\blow motivation\b/,
    /\bunmotivated\b/,
    /\bdragging\b/,
    /\bnot feeling it\b/,
    /\bflat\b/,
    /\bstruggling\b/,
    /\bno energy\b/,
  ];
  if (containsAny(text, lowPatterns)) return { score: 2, explicit: true, matchedSignals: ["motivation_low"] };

  const highPatterns = [
    /\bfired up\b/,
    /\bmotivated\b/,
    /\bready to go\b/,
    /\bpumped\b/,
    /\bgood energy\b/,
    /\bfeeling strong\b/,
    /\beager\b/,
  ];
  if (containsAny(text, highPatterns)) return { score: 8, explicit: true, matchedSignals: ["motivation_high"] };

  const mediumPatterns = [/\bokay energy\b/, /\bdecent energy\b/, /\bfine\b/, /\bsteady\b/];
  if (containsAny(text, mediumPatterns)) return { score: 5, explicit: true, matchedSignals: ["motivation_medium"] };

  return { score: null, explicit: false, matchedSignals: [] };
}

function inferCheckinType(text: string, timestampUtc: string | null | undefined, timeZone: string): { value: CoachCheckinType; explicit: boolean; matchedSignals: string[] } {
  const postWorkoutPatterns = [
    /\bpost[- ]?workout\b/,
    /\bafter workout\b/,
    /\bafter lift\b/,
    /\bafter session\b/,
    /\bafter training\b/,
    /\bworkout done\b/,
    /\bdone with (?:the )?(?:workout|lift|session)\b/,
    /\bfinished (?:the )?(?:workout|lift|session)\b/,
    /\bcompleted (?:the )?(?:workout|lift|session)\b/,
    /\btonal session\b/,
  ];
  if (containsAny(text, postWorkoutPatterns)) return { value: "post_workout", explicit: true, matchedSignals: ["checkin_type_post_workout"] };

  const eveningPatterns = [
    /\btonight\b/,
    /\bevening\b/,
    /\bbefore bed\b/,
    /\bend of day\b/,
    /\blater today\b/,
    /\bafter dinner\b/,
    /\bafter work\b/,
  ];
  if (containsAny(text, eveningPatterns)) return { value: "evening", explicit: true, matchedSignals: ["checkin_type_evening"] };

  const middayPatterns = [
    /\bmidday\b/,
    /\blunch\b/,
    /\bafter lunch\b/,
    /\bthis afternoon\b/,
    /\bduring the day\b/,
    /\bdaytime\b/,
  ];
  if (containsAny(text, middayPatterns)) return { value: "midday", explicit: true, matchedSignals: ["checkin_type_midday"] };

  const hour = localHour(timestampUtc, timeZone);
  if (hour != null && hour >= 17) return { value: "evening", explicit: false, matchedSignals: ["checkin_type_inferred_evening"] };
  if (hour != null && hour >= 11 && hour < 17) return { value: "midday", explicit: false, matchedSignals: ["checkin_type_inferred_midday"] };
  return { value: "ad_hoc", explicit: false, matchedSignals: [] };
}

export function parseCoachCheckin(text: string, options: ParseOptions = {}): CoachCheckinParse {
  const rawText = String(text ?? "");
  const normalized = normalizeText(rawText);
  const timeZone = options.timeZone ?? "America/New_York";

  const compliance = parseCompliance(normalized);
  const soreness = parseSoreness(normalized);
  const pain = parsePainFlag(normalized);
  const motivation = parseMotivation(normalized);
  const scheduleConstraints = extractScheduleConstraints(normalized);
  const checkinType = inferCheckinType(normalized, options.timestampUtc ?? null, timeZone);

  const explicitSignalCount =
    (compliance.explicit ? 1 : 0) +
    (soreness.explicit ? 1 : 0) +
    (pain.explicit ? 1 : 0) +
    (motivation.explicit ? 1 : 0) +
    (scheduleConstraints.length > 0 ? 1 : 0) +
    (checkinType.explicit ? 1 : 0);

  const matchedSignals = [
    ...compliance.matchedSignals,
    ...soreness.matchedSignals,
    ...pain.matchedSignals,
    ...motivation.matchedSignals,
    ...scheduleConstraints.map((constraint) => `schedule_${constraint}`),
    ...checkinType.matchedSignals,
  ];

  const confidence: CoachCheckinParse["confidence"] = (() => {
    if (explicitSignalCount >= 3) return "high";
    if (explicitSignalCount >= 1) return "medium";
    return "low";
  })();

  return {
    rawText,
    checkinType: checkinType.value,
    complianceStatus: compliance.status,
    completed: compliance.status === "completed",
    missed: compliance.status === "missed",
    sorenessScore: soreness.score,
    painFlag: pain.painFlag,
    motivationScore: motivation.score,
    scheduleConstraints,
    scheduleConstraint: scheduleConstraints[0] ?? null,
    explicitSignalCount,
    confidence,
    matchedSignals,
  };
}

export function hasCoachCheckinSignal(parsed: CoachCheckinParse): boolean {
  return parsed.explicitSignalCount > 0;
}

export function coachCheckinDateLocal(timestampUtc: string, timeZone = "America/New_York"): string {
  return localYmd(timeZone, new Date(timestampUtc));
}
