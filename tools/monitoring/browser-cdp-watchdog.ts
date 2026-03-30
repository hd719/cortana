#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

type BrowserProfile = {
  cdpUrl?: string;
  cdpPort?: number;
  driver?: string;
};

type OpenClawConfig = {
  browser?: {
    enabled?: boolean;
    defaultProfile?: string;
    profiles?: Record<string, BrowserProfile>;
  };
};

type StateShape = {
  restartTimestamps?: number[];
};

const CONFIG_PATH = path.join(os.homedir(), ".openclaw", "openclaw.json");
const STATE_PATH = path.join(os.homedir(), ".openclaw", "state", "browser-cdp-watchdog.json");
const WINDOW_MS = 30 * 60 * 1000;
const MAX_RESTARTS_PER_WINDOW = 1;
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app",
  "/Applications/Chromium.app",
  "/Applications/Brave Browser.app",
  "/Applications/Microsoft Edge.app",
] as const;

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeState(state: StateShape): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function trimRecent(times: number[], now: number): number[] {
  return times.filter((ts) => now - ts <= WINDOW_MS);
}

function compact(text: string, max = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "unknown";
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function resolveProfile(config: OpenClawConfig): { name: string; profile: BrowserProfile; cdpUrl: string } | null {
  if (config.browser?.enabled === false) return null;
  const profiles = config.browser?.profiles ?? {};
  const profileName = config.browser?.defaultProfile ?? "chrome-relay";
  const profile = profiles[profileName];
  if (!profile) return null;
  if (typeof profile.cdpUrl === "string" && profile.cdpUrl.trim()) {
    return { name: profileName, profile, cdpUrl: profile.cdpUrl.trim() };
  }
  if (Number.isFinite(profile.cdpPort)) {
    return { name: profileName, profile, cdpUrl: `http://127.0.0.1:${Number(profile.cdpPort)}` };
  }
  return null;
}

function checkCdp(url: string): { ok: boolean; detail: string } {
  const target = url.endsWith("/") ? `${url}json/version` : `${url}/json/version`;
  const probe = spawnSync("curl", ["-sSf", "--max-time", "6", target], { encoding: "utf8" });
  const detail = compact(`${probe.stdout ?? ""}\n${probe.stderr ?? ""}`);
  return { ok: probe.status === 0, detail: detail || target };
}

function parseLocalPort(cdpUrl: string): number | null {
  try {
    const parsed = new URL(cdpUrl);
    if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) return null;
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return Number.isFinite(port) ? port : null;
  } catch {
    return null;
  }
}

function findChromeApp(): string | null {
  for (const candidate of CHROME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function launchChromeRelay(profileName: string, cdpUrl: string): { ok: boolean; detail: string } {
  const app = findChromeApp();
  if (!app) {
    return { ok: false, detail: "no supported Chrome-family app found" };
  }
  const port = parseLocalPort(cdpUrl);
  if (!port) {
    return { ok: false, detail: `unsupported cdp url for local relay launch: ${cdpUrl}` };
  }
  const userDataDir = path.join(os.homedir(), ".openclaw", "browser", profileName);
  fs.mkdirSync(userDataDir, { recursive: true });
  const launch = spawnSync(
    "open",
    ["-na", app, "--args", `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`],
    { encoding: "utf8" }
  );
  const detail = compact(`${launch.stdout ?? ""}\n${launch.stderr ?? ""}`);
  return { ok: launch.status === 0, detail: detail || `${app} on ${port}` };
}

function verifyCdp(url: string, attempts = 8, sleepMs = 1000): { ok: boolean; detail: string } {
  let last = checkCdp(url);
  if (last.ok) return last;
  for (let i = 1; i < attempts; i += 1) {
    spawnSync("sleep", [String(Math.max(1, Math.ceil(sleepMs / 1000)))], { encoding: "utf8" });
    last = checkCdp(url);
    if (last.ok) return last;
  }
  return last;
}

function main(): void {
  const config = readJson<OpenClawConfig>(CONFIG_PATH);
  if (!config) {
    console.log("🌐 Browser/CDP watchdog actionable failure.\n- control_plane: runtime config unavailable");
    return;
  }

  const resolved = resolveProfile(config);
  if (!resolved) {
    console.log("NO_REPLY");
    return;
  }
  const { name: profileName, cdpUrl } = resolved;

  const initial = checkCdp(cdpUrl);
  if (initial.ok) {
    console.log("NO_REPLY");
    return;
  }

  const now = Date.now();
  const state = readJson<StateShape>(STATE_PATH) ?? {};
  const recent = trimRecent(state.restartTimestamps ?? [], now);
  if (recent.length >= MAX_RESTARTS_PER_WINDOW) {
    state.restartTimestamps = recent;
    writeState(state);
    console.log(
      [
        "🌐 Browser/CDP watchdog actionable failure.",
        `- control_plane: cdp_unhealthy budget_spent detail=${initial.detail}`,
      ].join("\n")
    );
    return;
  }

  const restart = launchChromeRelay(profileName, cdpUrl);
  recent.push(now);
  state.restartTimestamps = recent;
  writeState(state);

  const verified = verifyCdp(cdpUrl);
  if (restart.ok && verified.ok) {
    console.log("NO_REPLY");
    return;
  }

  console.log(
    [
      "🌐 Browser/CDP watchdog actionable failure.",
      `- control_plane: cdp_unhealthy_after_restart detail=${verified.detail}`,
    ].join("\n")
  );
}

main();
