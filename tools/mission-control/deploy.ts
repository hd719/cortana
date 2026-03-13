#!/usr/bin/env npx tsx
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { resolveRepoPath } from "../lib/paths.js";

const LOG_DIR = resolveRepoPath("tools", "mission-control", "logs");
const LOG_FILE = path.join(LOG_DIR, "deploy.log");

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function timestamp(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(
    now.getHours()
  )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function log(message: string): void {
  const line = `[${timestamp()}] ${message}`;
  process.stdout.write(`${line}\n`);
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  } catch {
    // ignore log write errors
  }
}

function fail(message: string): number {
  log(`❌ DEPLOY FAILED: ${message}`);
  return 1;
}

function runCommand(
  cmd: string,
  args: string[],
  cwd?: string
): { ok: boolean; status: number | null } {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd });
  return { ok: res.status === 0, status: res.status ?? null };
}

async function main(): Promise<number> {
  fs.mkdirSync(LOG_DIR, { recursive: true });

  log("🚀 Starting mission-control deploy");

  try {
    process.chdir("/Users/hd/Developer/cortana-external");
  } catch {
    return fail("Unable to cd to repo root");
  }

  log("Pulling latest changes from origin/main");
  const pull = runCommand("git", ["pull", "origin", "main"], process.cwd());
  if (!pull.ok) {
    return fail("git pull failed");
  }

  try {
    process.chdir(path.join(process.cwd(), "apps", "mission-control"));
  } catch {
    return fail("Unable to cd to apps/mission-control");
  }

  log("Installing dependencies (frozen lockfile)");
  const install = runCommand("/opt/homebrew/bin/pnpm", ["install", "--frozen-lockfile"], process.cwd());
  if (!install.ok) {
    return fail("pnpm install failed");
  }

  log("Building app");
  const build = runCommand("/opt/homebrew/bin/pnpm", ["build"], process.cwd());
  if (!build.ok) {
    return fail("pnpm build failed");
  }

  log("Restarting launchd service");
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const launch = runCommand("launchctl", ["kickstart", "-k", `gui/${uid}/com.cortana.mission-control`]);
  if (!launch.ok) {
    return fail("launchctl kickstart failed");
  }

  log("✅ DEPLOY SUCCESS");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
