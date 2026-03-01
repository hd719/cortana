export type SpawnValidationResult = {
  valid: boolean;
  reason?: string;
  suggestedFix?: string;
};

export type SpawnValidationInput = {
  /**
   * The harness value used for this spawn request.
   * Expected: "sessions_spawn"
   */
  harness?: string;
  /** Optional model selected for the request. */
  model?: string;
  /** Optional role / persona that the spawned agent is expected to fulfill. */
  role?: string;
};

const ROLE_MODEL_RULES: Record<string, RegExp[]> = {
  researcher: [/claude/i, /sonnet/i, /opus/i, /gpt/i],
  monitor: [/gpt/i, /claude/i],
  oracle: [/gpt/i, /claude/i],
  librarian: [/gpt/i, /claude/i],
  huragok: [/gpt/i, /claude/i, /codex/i],
};

function normalizeRole(role?: string): string {
  return (role ?? "").trim().toLowerCase();
}

function validateModelForRole(role: string, model?: string): SpawnValidationResult {
  if (!role || !model) {
    return { valid: true };
  }

  const rules = ROLE_MODEL_RULES[role];
  if (!rules || rules.length === 0) {
    return { valid: true };
  }

  const modelOk = rules.some((rule) => rule.test(model));
  if (modelOk) {
    return { valid: true };
  }

  const expectedHint = rules.map((r) => r.source.replace(/\\/g, "")).join(" or ");
  return {
    valid: false,
    reason: `Model '${model}' is not approved for role '${role}'.`,
    suggestedFix: `Use an allowed model for '${role}' (${expectedHint}) and route via sessions_spawn.`,
  };
}

/**
 * Validate a spawn request before execution.
 * Hard requirement: all agent spawns must be routed through sessions_spawn.
 */
export function validateSpawnRequest(input: SpawnValidationInput): SpawnValidationResult {
  const harness = (input.harness ?? "").trim().toLowerCase();

  if (harness !== "sessions_spawn") {
    return {
      valid: false,
      reason: "Spawn request is not using sessions_spawn.",
      suggestedFix: "Route agent creation through sessions_spawn and do not call claude/codex CLI directly.",
    };
  }

  const role = normalizeRole(input.role);
  return validateModelForRole(role, input.model);
}
