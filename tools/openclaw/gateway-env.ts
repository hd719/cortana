import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveHomePath } from "../lib/paths.js";

export const PRESERVED_GATEWAY_ENV_KEYS = ["GOG_KEYRING_PASSWORD"] as const;
export const DEFAULT_GATEWAY_ENV_STATE_PATH =
  process.env.OPENCLAW_GATEWAY_ENV_STATE_PATH ?? resolveHomePath(".openclaw", "state", "gateway-env.json");
export const DEFAULT_GATEWAY_BIN_DIR =
  process.env.OPENCLAW_GATEWAY_BIN_DIR ?? resolveHomePath(".openclaw", "bin");
const DEFAULT_GATEWAY_PATH_FALLBACK = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

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

export function ensureGatewayPathPrefix(
  currentPath: string | undefined,
  prefix: string = DEFAULT_GATEWAY_BIN_DIR,
): string {
  const base = nonEmpty(currentPath) ? currentPath : DEFAULT_GATEWAY_PATH_FALLBACK;
  const parts = base.split(":").filter(Boolean);
  const withoutPrefix = parts.filter((part) => part !== prefix);
  return [prefix, ...withoutPrefix].join(":");
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

export function readGatewayEnvStateFile(statePath: string = DEFAULT_GATEWAY_ENV_STATE_PATH): Record<string, string> {
  if (!fs.existsSync(statePath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const key of PRESERVED_GATEWAY_ENV_KEYS) {
      const value = parsed[key];
      if (nonEmpty(typeof value === "string" ? value : undefined)) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function readMergedGatewayEnvSources(
  plistPath: string,
  statePath: string = DEFAULT_GATEWAY_ENV_STATE_PATH,
): Record<string, string> {
  const plistEnv = readPlistEnvironmentVariables(plistPath);
  const stateEnv = readGatewayEnvStateFile(statePath);
  return {
    ...plistEnv,
    ...stateEnv,
  };
}

export function writeGatewayEnvStateFile(
  currentEnv: NodeJS.ProcessEnv = process.env,
  preservedSource: Record<string, string> = {},
  statePath: string = DEFAULT_GATEWAY_ENV_STATE_PATH,
): GatewayEnv {
  const desired = computePreservedGatewayEnv(currentEnv, preservedSource);
  if (Object.keys(desired).length === 0) {
    fs.rmSync(statePath, { force: true });
    return desired;
  }

  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(desired, null, 2) + "\n", "utf8");
  return desired;
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

  const desiredPath = ensureGatewayPathPrefix(currentEnv.PATH ?? existing.PATH);
  if (existing.PATH !== desiredPath) {
    const action = existing.PATH ? "-replace" : "-insert";
    const result = plutil([action, "EnvironmentVariables.PATH", "-string", desiredPath, plistPath]);
    if ((result.status ?? 1) !== 0) {
      throw new Error(`failed to persist PATH into ${plistPath}: ${String(result.stderr || result.stdout).trim()}`);
    }
    updated = true;
  }

  return { updated, applied: desired };
}
