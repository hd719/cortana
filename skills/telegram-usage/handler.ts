#!/usr/bin/env npx tsx

/**
 * Telegram /usage Command Handler
 * Displays session usage statistics in a clean, formatted message
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function getQuotaIndicator(percentage: number): string {
  if (percentage >= 75) return "🟢";
  if (percentage >= 50) return "🟡";
  if (percentage >= 25) return "🟠";
  return "🔴";
}

function parseTimeToMs(timeStr: string): number {
  let totalMs = 0;
  const hourMatch = timeStr.match(/(\d+)h/);
  if (hourMatch) totalMs += parseInt(hourMatch[1], 10) * 3600000;
  const minMatch = timeStr.match(/(\d+)m/);
  if (minMatch) totalMs += parseInt(minMatch[1], 10) * 60000;
  return totalMs;
}

interface QuotaData {
  quotaRemaining: number | null;
  sessionTimeRemaining: number | null;
  timeRemainingFormatted: string;
}

function getRealQuotaData(): QuotaData {
  const commands = ["openclaw models status", "clawdbot models status"];
  for (const cmd of commands) {
    try {
      const output = execSync(cmd, { encoding: "utf-8" });
      const usageLine = output.split("\n").find((line) => line.includes(" usage: "));
      if (!usageLine) continue;
      const pctMatch = usageLine.match(/(\d+)%\s+left/);
      const timeMatch = usageLine.match(/⏱\s*([^·\n]+)/);
      if (pctMatch) {
        const percentage = parseInt(pctMatch[1], 10);
        const timeRemaining = (timeMatch?.[1] || "0m").trim();
        const timeMs = parseTimeToMs(timeRemaining);
        return { quotaRemaining: percentage, sessionTimeRemaining: timeMs, timeRemainingFormatted: timeRemaining };
      }
    } catch {
      // Try next command
    }
  }
  return { quotaRemaining: null, sessionTimeRemaining: null, timeRemainingFormatted: "unknown" };
}

function getQuotaTrackerPath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(homeDir, ".openclaw", "quota-tracker.json");
}

interface QuotaTracker {
  startTime: number;
  resetHours: number;
}

export function getQuotaStartTime(): QuotaTracker {
  const trackerPath = getQuotaTrackerPath();
  if (!fs.existsSync(trackerPath)) {
    const quotaData: QuotaTracker = { startTime: Date.now(), resetHours: 4 };
    try {
      fs.writeFileSync(trackerPath, JSON.stringify(quotaData, null, 2));
    } catch (error) {
      console.error("Failed to create quota tracker:", (error as Error).message);
    }
    return quotaData;
  }
  try {
    return JSON.parse(fs.readFileSync(trackerPath, "utf-8"));
  } catch (error) {
    console.error("Failed to read quota tracker:", (error as Error).message);
    return { startTime: Date.now(), resetHours: 4 };
  }
}

export function getTimeUntilReset(): number {
  const quotaData = getQuotaStartTime();
  const resetHours = quotaData.resetHours || 4;
  const resetTime = quotaData.startTime + resetHours * 3600000;
  const timeRemaining = resetTime - Date.now();
  if (timeRemaining <= 0) {
    const trackerPath = getQuotaTrackerPath();
    try {
      fs.writeFileSync(trackerPath, JSON.stringify({ startTime: Date.now(), resetHours }, null, 2));
    } catch (error) {
      console.error("Failed to reset quota tracker:", (error as Error).message);
    }
    return resetHours * 3600000;
  }
  return timeRemaining;
}

interface UsageStats {
  quotaRemaining?: number | null;
  sessionTimeRemaining?: number | null;
  provider?: string;
}

export function generateUsageReport(stats: UsageStats): string {
  const { quotaRemaining = null, sessionTimeRemaining = null } = stats;
  const quotaKnown = Number.isFinite(quotaRemaining);
  const timeKnown = Number.isFinite(sessionTimeRemaining);
  const quotaIndicator = quotaKnown ? getQuotaIndicator(quotaRemaining!) : "⚪️";
  const timeRemaining = timeKnown ? formatDuration(sessionTimeRemaining!) : "unknown";
  let message = `📊 API Usage\n\n`;
  message += `🔋 Quota: ${quotaIndicator} ${quotaKnown ? `${quotaRemaining}%` : "unknown"}\n`;
  message += `⏱️ Resets in: ${timeRemaining}`;
  return message;
}

export function parseContextData(contextInfo: string | null): { used: number; total: number } | null {
  if (!contextInfo) return null;
  const tokenMatch = contextInfo.match(/(\d+)\s*\/\s*(\d+)/);
  if (tokenMatch) return { used: parseInt(tokenMatch[1]), total: parseInt(tokenMatch[2]) };
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || "report";
  const quotaData = getRealQuotaData();

  const stats = {
    quotaRemaining: quotaData.quotaRemaining,
    sessionTimeRemaining: quotaData.sessionTimeRemaining,
    totalTokens: { input: 2847, output: 1523 },
    contextUsage: { used: 1856, total: 4096 },
    model: "Claude 3.5 Haiku",
    provider: "anthropic",
  };

  if (command === "report") {
    console.log(generateUsageReport(stats));
    process.exit(0);
  }
  if (command === "json") {
    console.log(JSON.stringify(stats, null, 2));
    process.exit(0);
  }
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}

// Run if invoked directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isMain) {
  main().catch((err) => {
    console.error("Error:", (err as Error).message);
    process.exit(1);
  });
}
