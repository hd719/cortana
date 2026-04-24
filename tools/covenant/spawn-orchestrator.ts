import { validateSpawnRequest, type SpawnValidationResult } from "../guardrails/spawn-validator.js";

export type SpawnHandshake = {
  harness?: string;
  model?: string;
  role?: string;
  objective?: string;
  repoPath?: string;
};

export type SpawnPlan = {
  valid: boolean;
  role: string;
  model: string;
  harness: string;
  objective: string;
  repoPath: string | null;
  validation: SpawnValidationResult;
  preflight: Array<{ name: string; ok: boolean; reason?: string }>;
};

const DEFAULT_MODEL_BY_ROLE: Record<string, string> = {
  huragok: "openai-codex/gpt-5.3-codex",
  monitor: "openai-codex/gpt-5.4",
  oracle: "openai-codex/gpt-5.4",
  researcher: "openai-codex/gpt-5.4",
  librarian: "openai-codex/gpt-5.3-codex",
};

export function normalizeSpawnHandshake(input: SpawnHandshake): Required<Pick<SpawnHandshake, "harness" | "model" | "role" | "objective">> & { repoPath: string | null } {
  const role = String(input.role ?? "huragok").trim().toLowerCase();
  return {
    harness: String(input.harness ?? "sessions_spawn").trim(),
    model: String(input.model ?? DEFAULT_MODEL_BY_ROLE[role] ?? "openai-codex/gpt-5.3-codex").trim(),
    role,
    objective: String(input.objective ?? "").trim(),
    repoPath: input.repoPath ? String(input.repoPath).trim() : null,
  };
}

export function planSpawn(input: SpawnHandshake): SpawnPlan {
  const normalized = normalizeSpawnHandshake(input);
  const validation = validateSpawnRequest({ harness: normalized.harness, model: normalized.model, role: normalized.role });
  const preflight = [
    { name: "objective", ok: normalized.objective.length > 0, reason: normalized.objective ? undefined : "objective missing" },
    { name: "repo", ok: normalized.repoPath !== "", reason: normalized.repoPath === "" ? "repo path empty" : undefined },
  ];

  return {
    ...normalized,
    valid: validation.valid && preflight.every((check) => check.ok),
    validation,
    preflight,
  };
}

export function renderSpawnPrompt(plan: SpawnPlan): string {
  return [
    `Role: ${plan.role}`,
    `Model: ${plan.model}`,
    plan.repoPath ? `Repo: ${plan.repoPath}` : null,
    "Objective:",
    plan.objective || "(missing objective)",
  ].filter(Boolean).join("\n");
}
