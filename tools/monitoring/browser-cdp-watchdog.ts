#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

type BrowserProfile = {
  cdpUrl?: string;
  cdpPort?: number;
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

function resolveCdpUrl(config: OpenClawConfig): string | null {
  if (config.browser?.enabled === false) return null;
  const profiles = config.browser?.profiles ?? {};
  const profileName = config.browser?.defaultProfile ?? "chrome-relay";
  const profile = profiles[profileName];
  if (!profile) return null;
  if (typeof profile.cdpUrl === "string" && profile.cdpUrl.trim()) return profile.cdpUrl.trim();
  if (Number.isFinite(profile.cdpPort)) return `http://127.0.0.1:${Number(profile.cdpPort)}`;
  return null;
}

function checkCdp(url: string): { ok: boolean; detail: string } {
  const target = url.endsWith("/") ? `${url}json/version` : `${url}/json/version`;
  const probe = spawnSync("curl", ["-sSf", "--max-time", "6", target], { encoding: "utf8" });
  const detail = compact(`${probe.stdout ?? ""}\n${probe.stderr ?? ""}`);
  return { ok: probe.status === 0, detail: detail || target };
}

function restartBrowserHost(): { ok: boolean; detail: string } {
  const restart = spawnSync("openclaw", ["node", "restart"], { encoding: "utf8" });
  const detail = compact(`${restart.stdout ?? ""}\n${restart.stderr ?? ""}`);
  return { ok: restart.status === 0, detail };
}

function main(): void {
  const config = readJson<OpenClawConfig>(CONFIG_PATH);
  if (!config) {
    console.log("🌐 Browser/CDP watchdog actionable failure.\n- control_plane: runtime config unavailable");
    return;
  }

  const cdpUrl = resolveCdpUrl(config);
  if (!cdpUrl) {
    console.log("NO_REPLY");
    return;
  }

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

  const restart = restartBrowserHost();
  recent.push(now);
  state.restartTimestamps = recent;
  writeState(state);

  const verified = checkCdp(cdpUrl);
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
