export const CATEGORIES = ["financial", "deployment", "system", "personal"] as const;
export const PRIORITIES = ["critical", "high", "normal", "low"] as const;
export const STATUSES = ["pending", "executed", "cancelled", "expired"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Status = (typeof STATUSES)[number];

const categorySet = new Set<string>(CATEGORIES);
const prioritySet = new Set<string>(PRIORITIES);
const statusSet = new Set<string>(STATUSES);

export function assertCategory(value: string): asserts value is Category {
  if (!categorySet.has(value)) {
    throw new Error(`Invalid category: ${value}. Allowed: ${CATEGORIES.join("|")}`);
  }
}

export function assertPriority(value: string): asserts value is Priority {
  if (!prioritySet.has(value)) {
    throw new Error(`Invalid priority: ${value}. Allowed: ${PRIORITIES.join("|")}`);
  }
}

export function assertStatus(value: string): asserts value is Status {
  if (!statusSet.has(value)) {
    throw new Error(`Invalid status: ${value}. Allowed: ${STATUSES.join("|")}`);
  }
}

export function sqlEscape(text: string): string {
  return text.replace(/'/g, "''");
}

export function parseJsonArgument(raw?: string): unknown | undefined {
  if (raw == null || raw === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON for details: ${msg}`);
  }
}

export function parseExpiresMinutes(raw?: string): number | undefined {
  if (raw == null || raw === "") return undefined;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || Number.isNaN(value)) {
    throw new Error(`Invalid expires_minutes: ${raw}`);
  }
  if (value <= 0) {
    throw new Error(`expires_minutes must be > 0 (got ${raw})`);
  }
  return value;
}

export function ensureNonEmpty(value: string, label: string): void {
  if (!value || !value.trim()) {
    throw new Error(`${label} is required`);
  }
}
