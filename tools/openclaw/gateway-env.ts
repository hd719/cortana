import fs from "node:fs";
import { spawnSync } from "node:child_process";

export const PRESERVED_GATEWAY_ENV_KEYS = ["GOG_KEYRING_PASSWORD"] as const;

type GatewayEnv = Partial<Record<(typeof PRESERVED_GATEWAY_ENV_KEYS)[number], string>>;

function plutil(args: string[]) {
  return spawnSync("plutil", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function nonEmpty(value: string | undefined | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function computePreservedGatewayEnv(
  currentEnv: NodeJS.ProcessEnv,
  existingPlistEnv: Record<string, string> = {},
): GatewayEnv {
  const preserved: GatewayEnv = {};
  for (const key of PRESERVED_GATEWAY_ENV_KEYS) {
    const preferred = currentEnv[key];
    const fallback = existingPlistEnv[key];
    if (nonEmpty(preferred)) {
      preserved[key] = preferred;
    } else if (nonEmpty(fallback)) {
      preserved[key] = fallback;
    }
  }
  return preserved;
}

export function readPlistEnvironmentVariables(plistPath: string): Record<string, string> {
  if (!fs.existsSync(plistPath)) return {};
  const converted = plutil(["-convert", "json", "-o", "-", plistPath]);
  if ((converted.status ?? 1) !== 0) return {};
  try {
    const parsed = JSON.parse(String(converted.stdout ?? "{}")) as { EnvironmentVariables?: Record<string, string> };
    return parsed.EnvironmentVariables ?? {};
  } catch {
    return {};
  }
}

export function reconcileGatewayPlistEnv(
  plistPath: string,
  currentEnv: NodeJS.ProcessEnv = process.env,
  preservedSource: Record<string, string> = {},
): { updated: boolean; applied: GatewayEnv } {
  if (!fs.existsSync(plistPath)) {
    return { updated: false, applied: {} };
  }

  const existing = readPlistEnvironmentVariables(plistPath);
  const desired = computePreservedGatewayEnv(currentEnv, {
    ...preservedSource,
    ...existing,
  });

  let updated = false;
  for (const key of PRESERVED_GATEWAY_ENV_KEYS) {
    const value = desired[key];
    if (!nonEmpty(value) || existing[key] === value) continue;
    const action = existing[key] ? "-replace" : "-insert";
    const result = plutil([action, `EnvironmentVariables.${key}`, "-string", value, plistPath]);
    if ((result.status ?? 1) !== 0) {
      throw new Error(`failed to persist ${key} into ${plistPath}: ${String(result.stderr || result.stdout).trim()}`);
    }
    updated = true;
  }

  return { updated, applied: desired };
}
