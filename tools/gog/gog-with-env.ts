#!/usr/bin/env -S npx tsx
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { readMergedGatewayEnvSources } from "../openclaw/gateway-env.js";

export function buildGogEnv(
  currentEnv: NodeJS.ProcessEnv = process.env,
  inheritedEnv: Record<string, string> = {},
): NodeJS.ProcessEnv {
  if (typeof currentEnv.GOG_KEYRING_PASSWORD === "string" && currentEnv.GOG_KEYRING_PASSWORD.trim().length > 0) {
    return currentEnv;
  }
  const inherited = inheritedEnv.GOG_KEYRING_PASSWORD;
  if (typeof inherited !== "string" || inherited.trim().length === 0) {
    return currentEnv;
  }
  return {
    ...currentEnv,
    GOG_KEYRING_PASSWORD: inherited,
  };
}

export function runGogWithEnv(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  plistPath: string = process.env.OPENCLAW_GATEWAY_PLIST || `${process.env.HOME}/Library/LaunchAgents/ai.openclaw.gateway.plist`,
) {
  const mergedEnv = buildGogEnv(env, readMergedGatewayEnvSources(plistPath));
  return spawnSync(resolveRealGogBin(mergedEnv), args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: mergedEnv,
  });
}

export function resolveRealGogBin(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_REAL_GOG_BIN;
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit;

  const home = env.HOME ?? process.env.HOME ?? "";
  const shimPath = home ? `${home}/.openclaw/bin/gog` : "";
  const candidates = [
    "/opt/homebrew/bin/gog",
    "/usr/local/bin/gog",
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && candidate !== shimPath) return candidate;
    } catch {
      continue;
    }
  }

  return "gog";
}

export function main(argv = process.argv.slice(2)) {
  const result = runGogWithEnv(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
