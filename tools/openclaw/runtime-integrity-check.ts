#!/usr/bin/env -S npx tsx
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_GATEWAY_ENV_STATE_PATH,
  readMergedGatewayEnvSources,
  reconcileGatewayPlistEnv,
  writeGatewayEnvStateFile,
} from "./gateway-env.js";

type CheckResult = { name: string; ok: boolean; detail: string; repaired?: boolean };

const GATEWAY_PLIST = path.join(os.homedir(), "Library", "LaunchAgents", "ai.openclaw.gateway.plist");

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const proc = spawnSync(cmd, args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: proc.status ?? 1,
    stdout: String(proc.stdout ?? ""),
    stderr: String(proc.stderr ?? ""),
  };
}

function mergedEnv(): Record<string, string> {
  return readMergedGatewayEnvSources(GATEWAY_PLIST, DEFAULT_GATEWAY_ENV_STATE_PATH);
}

function checkGateway(): CheckResult {
  const res = run("openclaw", ["gateway", "status", "--no-probe"]);
  return {
    name: "gateway_service",
    ok: res.status === 0,
    detail: (res.stderr || res.stdout || "gateway unhealthy").trim(),
  };
}

function checkGogAccess(): CheckResult {
  const env = { ...process.env, ...mergedEnv() };
  const res = run("gog", ["auth", "list", "--json", "--no-input"], env);
  return {
    name: "gog_headless_auth",
    ok: res.status === 0,
    detail: (res.stderr || res.stdout || "gog auth failed").trim(),
  };
}

function checkTelegramPlugin(): CheckResult {
  const res = run("openclaw", ["plugins", "inspect", "telegram"]);
  const merged = `${res.stdout}\n${res.stderr}`.trim();
  return {
    name: "telegram_plugin",
    ok: res.status === 0 && /Status:\s*loaded/i.test(merged),
    detail: merged || "telegram inspect failed",
  };
}

function repairGatewayEnv(): boolean {
  const preserved = readMergedGatewayEnvSources(GATEWAY_PLIST, DEFAULT_GATEWAY_ENV_STATE_PATH);
  writeGatewayEnvStateFile(process.env, preserved, DEFAULT_GATEWAY_ENV_STATE_PATH);
  const reconciled = reconcileGatewayPlistEnv(GATEWAY_PLIST, process.env, preserved);
  return reconciled.updated || Object.keys(preserved).length > 0;
}

function main() {
  const json = process.argv.includes("--json");
  const repair = process.argv.includes("--repair");
  const results = [checkGateway(), checkGogAccess(), checkTelegramPlugin()];

  if (repair && results.some((item) => !item.ok && item.name === "gog_headless_auth")) {
    const repaired = repairGatewayEnv();
    if (repaired) {
      const rerun = checkGogAccess();
      rerun.repaired = true;
      results[1] = rerun;
    }
  }

  const summary = {
    checkedAt: new Date().toISOString(),
    overall_ok: results.every((item) => item.ok),
    results,
    gatewayPlist: GATEWAY_PLIST,
    stateFile: DEFAULT_GATEWAY_ENV_STATE_PATH,
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else if (summary.overall_ok) {
    console.log("NO_REPLY");
  } else {
    console.log([
      "🧩 Runtime integrity check failed.",
      ...results.filter((item) => !item.ok).map((item) => `- ${item.name}: ${item.detail}`),
    ].join("\n"));
  }

  process.exit(summary.overall_ok ? 0 : 1);
}

main();
