import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type NotificationSeverity = "immediate" | "digest" | "silent";

const FOCUS_FILE = path.join(os.homedir(), ".openclaw", "focus-mode.json");
const DIGEST_DIR = path.join(os.homedir(), ".openclaw", "tmp", "notification-digests");

export function normalizeSeverity(raw: string | undefined | null): NotificationSeverity {
  const value = String(raw ?? "immediate").trim().toLowerCase();
  if (value === "digest") return "digest";
  if (value === "silent") return "silent";
  return "immediate";
}

export function isFocusModeActive(now = new Date()): boolean {
  if ([0, 6].includes(now.getDay())) return true;
  try {
    const raw = JSON.parse(fs.readFileSync(FOCUS_FILE, "utf8"));
    return raw?.active === true;
  } catch {
    return false;
  }
}

export function digestFileFor(now = new Date()): string {
  fs.mkdirSync(DIGEST_DIR, { recursive: true });
  return path.join(DIGEST_DIR, `${now.toISOString().slice(0, 10)}.jsonl`);
}

export function appendDigestEntry(entry: Record<string, unknown>, now = new Date()): string {
  const file = digestFileFor(now);
  fs.appendFileSync(file, `${JSON.stringify({ ...entry, queuedAt: now.toISOString() })}\n`, "utf8");
  return file;
}
