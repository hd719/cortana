export type TonalTemplateGoalMode = "hypertrophy" | "maintenance" | "recovery" | "cut_support" | "strength_bias";
export type TonalTemplateSplitType = "upper_lower" | "ppl" | "full_body" | "recovery" | "fallback";
export type TonalTemplateFocus = "upper" | "lower" | "push" | "pull" | "full_body" | "recovery" | "fallback";

export type TonalTemplateSlot = {
  slotId: string;
  label: string;
  targetMuscles: string[];
  preferredPatterns: string[];
  setTarget: number;
  repRange: [number, number];
};

export type TonalTemplateBlock = {
  blockId: string;
  label: string;
  goal: string;
  slots: TonalTemplateSlot[];
};

export type TonalProgramTemplate = {
  templateId: string;
  version: number;
  goalMode: TonalTemplateGoalMode;
  splitType: TonalTemplateSplitType;
  durationMinutes: number;
  tonalRequired: boolean;
  templateBody: {
    focus: TonalTemplateFocus;
    sessionLabel: string;
    blocks: TonalTemplateBlock[];
  };
  tags: string[];
  active: boolean;
};

function defineTemplate(input: TonalProgramTemplate): TonalProgramTemplate {
  return input;
}

export const DEFAULT_TONAL_PROGRAM_TEMPLATES: TonalProgramTemplate[] = [
  defineTemplate({
    templateId: "upper-hypertrophy-45m-v1",
    version: 1,
    goalMode: "hypertrophy",
    splitType: "upper_lower",
    durationMinutes: 45,
    tonalRequired: true,
    templateBody: {
      focus: "upper",
      sessionLabel: "Upper Hypertrophy 45m",
      blocks: [
        {
          blockId: "primary-press-pull",
          label: "Primary Press + Pull",
          goal: "Build high-quality upper-body volume without dragging lower-body fatigue.",
          slots: [
            { slotId: "press", label: "Primary Press", targetMuscles: ["chest", "shoulders", "triceps"], preferredPatterns: ["press"], setTarget: 4, repRange: [6, 10] },
            { slotId: "pull", label: "Primary Pull", targetMuscles: ["back", "lats", "biceps"], preferredPatterns: ["row", "pull_down"], setTarget: 4, repRange: [6, 10] },
          ],
        },
        {
          blockId: "accessory-upper",
          label: "Accessory Upper",
          goal: "Fill lagging upper-body volume with controlled fatigue.",
          slots: [
            { slotId: "fly", label: "Chest/Shoulder Accessory", targetMuscles: ["chest", "shoulders"], preferredPatterns: ["fly", "raise"], setTarget: 3, repRange: [10, 15] },
            { slotId: "arm", label: "Arm Finisher", targetMuscles: ["biceps", "triceps"], preferredPatterns: ["curl", "extension"], setTarget: 3, repRange: [10, 15] },
          ],
        },
      ],
    },
    tags: ["upper_emphasis", "hypertrophy", "default_duration_45"],
    active: true,
  }),
  defineTemplate({
    templateId: "lower-hypertrophy-45m-v1",
    version: 1,
    goalMode: "hypertrophy",
    splitType: "upper_lower",
    durationMinutes: 45,
    tonalRequired: true,
    templateBody: {
      focus: "lower",
      sessionLabel: "Lower Hypertrophy 45m",
      blocks: [
        {
          blockId: "primary-lower",
          label: "Primary Lower",
          goal: "Drive productive lower-body volume when recovery and interference allow it.",
          slots: [
            { slotId: "squat", label: "Squat Pattern", targetMuscles: ["quads", "glutes"], preferredPatterns: ["squat", "lunge"], setTarget: 4, repRange: [6, 10] },
            { slotId: "hinge", label: "Hinge Pattern", targetMuscles: ["hamstrings", "glutes"], preferredPatterns: ["hinge"], setTarget: 4, repRange: [6, 10] },
          ],
        },
        {
          blockId: "lower-accessory",
          label: "Lower Accessory",
          goal: "Round out lower-body and core work without junk fatigue.",
          slots: [
            { slotId: "single-leg", label: "Single-Leg Stability", targetMuscles: ["quads", "glutes"], preferredPatterns: ["lunge"], setTarget: 3, repRange: [10, 15] },
            { slotId: "core", label: "Core Stability", targetMuscles: ["core"], preferredPatterns: ["anti_rotation", "rotation", "plank"], setTarget: 3, repRange: [8, 14] },
          ],
        },
      ],
    },
    tags: ["lower_emphasis", "hypertrophy", "default_duration_45"],
    active: true,
  }),
  defineTemplate({
    templateId: "push-45m-v1",
    version: 1,
    goalMode: "hypertrophy",
    splitType: "ppl",
    durationMinutes: 45,
    tonalRequired: true,
    templateBody: {
      focus: "push",
      sessionLabel: "Push 45m",
      blocks: [
        {
          blockId: "push-main",
          label: "Push Main",
          goal: "Bias pressing volume while containing total session complexity.",
          slots: [
            { slotId: "horizontal-press", label: "Horizontal Press", targetMuscles: ["chest", "triceps"], preferredPatterns: ["press"], setTarget: 4, repRange: [6, 10] },
            { slotId: "vertical-press", label: "Vertical Press", targetMuscles: ["shoulders", "triceps"], preferredPatterns: ["press"], setTarget: 3, repRange: [8, 12] },
            { slotId: "push-accessory", label: "Push Accessory", targetMuscles: ["chest", "shoulders"], preferredPatterns: ["fly", "raise"], setTarget: 3, repRange: [10, 15] },
          ],
        },
      ],
    },
    tags: ["push_bias", "hypertrophy", "default_duration_45"],
    active: true,
  }),
  defineTemplate({
    templateId: "pull-45m-v1",
    version: 1,
    goalMode: "hypertrophy",
    splitType: "ppl",
    durationMinutes: 45,
    tonalRequired: true,
    templateBody: {
      focus: "pull",
      sessionLabel: "Pull 45m",
      blocks: [
        {
          blockId: "pull-main",
          label: "Pull Main",
          goal: "Bias upper-back, lats, and arm pulling without lower-body spillover.",
          slots: [
            { slotId: "row", label: "Row Pattern", targetMuscles: ["back", "rear_delts", "biceps"], preferredPatterns: ["row"], setTarget: 4, repRange: [6, 10] },
            { slotId: "pulldown", label: "Pulldown Pattern", targetMuscles: ["lats", "biceps"], preferredPatterns: ["pull_down"], setTarget: 3, repRange: [8, 12] },
            { slotId: "curl", label: "Curl Accessory", targetMuscles: ["biceps"], preferredPatterns: ["curl"], setTarget: 3, repRange: [10, 15] },
          ],
        },
      ],
    },
    tags: ["pull_bias", "hypertrophy", "default_duration_45"],
    active: true,
  }),
  defineTemplate({
    templateId: "full-body-30m-v1",
    version: 1,
    goalMode: "maintenance",
    splitType: "full_body",
    durationMinutes: 30,
    tonalRequired: true,
    templateBody: {
      focus: "full_body",
      sessionLabel: "Full Body 30m",
      blocks: [
        {
          blockId: "full-body-priority",
          label: "Full Body Priority",
          goal: "Cover the largest muscle groups when time is constrained.",
          slots: [
            { slotId: "push", label: "Push", targetMuscles: ["chest", "shoulders", "triceps"], preferredPatterns: ["press"], setTarget: 3, repRange: [6, 10] },
            { slotId: "pull", label: "Pull", targetMuscles: ["back", "lats", "biceps"], preferredPatterns: ["row", "pull_down"], setTarget: 3, repRange: [6, 10] },
            { slotId: "legs", label: "Lower Body", targetMuscles: ["quads", "hamstrings", "glutes"], preferredPatterns: ["squat", "hinge", "lunge"], setTarget: 3, repRange: [8, 12] },
          ],
        },
      ],
    },
    tags: ["full_body", "time_constrained", "default_duration_30"],
    active: true,
  }),
  defineTemplate({
    templateId: "recovery-30m-v1",
    version: 1,
    goalMode: "recovery",
    splitType: "recovery",
    durationMinutes: 30,
    tonalRequired: true,
    templateBody: {
      focus: "recovery",
      sessionLabel: "Recovery 30m",
      blocks: [
        {
          blockId: "recovery-circuit",
          label: "Recovery Circuit",
          goal: "Keep movement quality high while minimizing fatigue cost.",
          slots: [
            { slotId: "upper-technique", label: "Upper Technique", targetMuscles: ["back", "shoulders"], preferredPatterns: ["row", "raise"], setTarget: 2, repRange: [10, 15] },
            { slotId: "lower-technique", label: "Lower Technique", targetMuscles: ["glutes", "core"], preferredPatterns: ["lunge", "anti_rotation"], setTarget: 2, repRange: [10, 15] },
          ],
        },
      ],
    },
    tags: ["low_fatigue", "recovery", "default_duration_30"],
    active: true,
  }),
  defineTemplate({
    templateId: "cut-support-upper-45m-v1",
    version: 1,
    goalMode: "cut_support",
    splitType: "upper_lower",
    durationMinutes: 45,
    tonalRequired: true,
    templateBody: {
      focus: "upper",
      sessionLabel: "Cut Support Upper 45m",
      blocks: [
        {
          blockId: "cut-upper-main",
          label: "Cut Support Upper",
          goal: "Protect upper-body muscle during a cut with moderate fatigue.",
          slots: [
            { slotId: "press", label: "Press", targetMuscles: ["chest", "shoulders", "triceps"], preferredPatterns: ["press"], setTarget: 3, repRange: [6, 10] },
            { slotId: "pull", label: "Pull", targetMuscles: ["back", "lats", "biceps"], preferredPatterns: ["row", "pull_down"], setTarget: 3, repRange: [6, 10] },
            { slotId: "arm", label: "Arm Retention", targetMuscles: ["biceps", "triceps"], preferredPatterns: ["curl", "extension"], setTarget: 2, repRange: [10, 15] },
          ],
        },
      ],
    },
    tags: ["upper_emphasis", "cut_safe", "default_duration_45"],
    active: true,
  }),
  defineTemplate({
    templateId: "cut-support-lower-45m-v1",
    version: 1,
    goalMode: "cut_support",
    splitType: "upper_lower",
    durationMinutes: 45,
    tonalRequired: true,
    templateBody: {
      focus: "lower",
      sessionLabel: "Cut Support Lower 45m",
      blocks: [
        {
          blockId: "cut-lower-main",
          label: "Cut Support Lower",
          goal: "Protect lower-body muscle while respecting cardio interference risk.",
          slots: [
            { slotId: "squat", label: "Squat/Lunge", targetMuscles: ["quads", "glutes"], preferredPatterns: ["squat", "lunge"], setTarget: 3, repRange: [6, 10] },
            { slotId: "hinge", label: "Hinge", targetMuscles: ["hamstrings", "glutes"], preferredPatterns: ["hinge"], setTarget: 3, repRange: [6, 10] },
            { slotId: "core", label: "Core", targetMuscles: ["core"], preferredPatterns: ["anti_rotation", "rotation"], setTarget: 2, repRange: [10, 15] },
          ],
        },
      ],
    },
    tags: ["lower_emphasis", "cut_safe", "default_duration_45"],
    active: true,
  }),
  defineTemplate({
    templateId: "fallback-travel-20m-v1",
    version: 1,
    goalMode: "maintenance",
    splitType: "fallback",
    durationMinutes: 20,
    tonalRequired: false,
    templateBody: {
      focus: "fallback",
      sessionLabel: "Travel Fallback 20m",
      blocks: [
        {
          blockId: "fallback",
          label: "Minimal Dose",
          goal: "Deliver a minimal useful session when time or equipment collapses.",
          slots: [
            { slotId: "full-body", label: "Full Body Slot", targetMuscles: ["chest", "back", "quads"], preferredPatterns: ["press", "row", "squat"], setTarget: 2, repRange: [8, 12] },
          ],
        },
      ],
    },
    tags: ["fallback", "time_constrained", "low_fatigue"],
    active: true,
  }),
];

export function selectTonalTemplates(input: {
  templates?: TonalProgramTemplate[];
  goalMode: TonalTemplateGoalMode;
  availableTimeMinutes: number;
  preferredTags?: string[];
  weeklyRecommendationMode?: string | null;
  readinessBand?: string | null;
}): TonalProgramTemplate[] {
  const templates = input.templates ?? DEFAULT_TONAL_PROGRAM_TEMPLATES;
  const preferredTags = new Set(input.preferredTags ?? []);
  const readinessBand = input.readinessBand ?? "unknown";
  return templates
    .filter((template) => template.active)
    .filter((template) => {
      if (readinessBand === "red") return template.goalMode === "recovery" || template.tags.includes("low_fatigue");
      if (input.goalMode === "cut_support") return template.goalMode === "cut_support" || template.goalMode === "maintenance";
      if (input.goalMode === "hypertrophy") return template.goalMode === "hypertrophy" || template.goalMode === "maintenance";
      return template.goalMode === input.goalMode || template.goalMode === "maintenance";
    })
    .sort((a, b) => {
      const aDurationGap = Math.abs(a.durationMinutes - input.availableTimeMinutes);
      const bDurationGap = Math.abs(b.durationMinutes - input.availableTimeMinutes);
      const aTagScore = a.tags.reduce((sum, tag) => sum + (preferredTags.has(tag) ? 1 : 0), 0);
      const bTagScore = b.tags.reduce((sum, tag) => sum + (preferredTags.has(tag) ? 1 : 0), 0);
      const aRecoveryBias = readinessBand === "red" && a.tags.includes("low_fatigue") ? 1 : 0;
      const bRecoveryBias = readinessBand === "red" && b.tags.includes("low_fatigue") ? 1 : 0;
      return (
        bRecoveryBias - aRecoveryBias
        || bTagScore - aTagScore
        || aDurationGap - bDurationGap
        || a.templateId.localeCompare(b.templateId)
      );
    });
}
