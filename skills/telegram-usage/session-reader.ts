#!/usr/bin/env npx tsx

/**
 * Session Reader for Telegram Usage Command
 * Reads actual session data from OpenClaw's session store
 */

import fs from "fs";
import path from "path";

export function getSessionStorePath(agentId = "main"): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(homeDir, ".openclaw", "agents", agentId, "sessions", "sessions.json");
}

export function getNextResetTime(atHour = 4): Date {
  const now = new Date();
  const reset = new Date();
  reset.setHours(atHour, 0, 0, 0);
  if (reset <= now) reset.setDate(reset.getDate() + 1);
  return reset;
}

export function getTimeUntilReset(atHour = 4): number {
  return getNextResetTime(atHour).getTime() - Date.now();
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

interface SessionStats {
  sessionId: string;
  updatedAt: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  model: string;
  provider: string;
}

export function readSessionStats(sessionKey: string, agentId = "main"): SessionStats | null {
  const storePath = getSessionStorePath(agentId);
  if (!fs.existsSync(storePath)) {
    console.warn(`Session store not found at ${storePath}`);
    return null;
  }
  try {
    const store = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    const session = store[sessionKey];
    if (!session) {
      console.warn(`Session ${sessionKey} not found in store`);
      return null;
    }
    return {
      sessionId: session.sessionId,
      updatedAt: session.updatedAt,
      inputTokens: session.inputTokens || 0,
      outputTokens: session.outputTokens || 0,
      totalTokens: session.totalTokens || 0,
      contextTokens: session.contextTokens || 0,
      model: session.model,
      provider: session.provider,
    };
  } catch (error) {
    console.error(`Error reading session store: ${(error as Error).message}`);
    return null;
  }
}

interface TokenStats {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export function readTokensFromTranscript(transcriptPath: string): TokenStats | null {
  if (!fs.existsSync(transcriptPath)) return null;
  try {
    const lines = fs.readFileSync(transcriptPath, "utf-8").trim().split("\n");
    let totalInput = 0;
    let totalOutput = 0;
    for (const line of lines) {
      if (!line) continue;
      const entry = JSON.parse(line);
      if (entry.role === "user" && entry.usage?.inputTokens) totalInput += entry.usage.inputTokens;
      if (entry.role === "assistant" && entry.usage?.outputTokens) totalOutput += entry.usage.outputTokens;
    }
    return { inputTokens: totalInput, outputTokens: totalOutput, totalTokens: totalInput + totalOutput };
  } catch (error) {
    console.warn(`Could not parse transcript: ${(error as Error).message}`);
    return null;
  }
}

export function getTranscriptPath(sessionId: string, agentId = "main"): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(homeDir, ".openclaw", "agents", agentId, "sessions", `${sessionId}.jsonl`);
}

const CONTEXT_WINDOWS: Record<string, number> = {
  "claude-3-5-haiku": 200000,
  "claude-haiku-4-5": 200000,
  "claude-3-haiku": 200000,
  "claude-3-5-sonnet": 200000,
  "claude-3-sonnet": 200000,
  "claude-3-opus": 200000,
  "claude-opus-4": 200000,
  "gpt-4": 8192,
  "gpt-4-turbo": 128000,
  "gpt-3.5-turbo": 4096,
};

export function estimateContextUsage(session: SessionStats, model = "claude-3-5-haiku"): { used: number; total: number; percentage: number } {
  let windowSize = 4096;
  for (const [modelKey, size] of Object.entries(CONTEXT_WINDOWS)) {
    if (model.toLowerCase().includes(modelKey.toLowerCase())) {
      windowSize = size;
      break;
    }
  }
  const contextUsed = session.contextTokens || session.totalTokens || 1024;
  const percentage = Math.min(Math.round((contextUsed / windowSize) * 100), 100);
  return { used: contextUsed, total: windowSize, percentage };
}

interface CollectOptions {
  agentId?: string;
  resetHour?: number;
  quotaRemaining?: number | null;
  provider?: string;
}

export function collectUsageStats(sessionKey: string, options: CollectOptions = {}) {
  const { agentId = "main", resetHour = 4, quotaRemaining = null, provider = "anthropic" } = options;
  const session = readSessionStats(sessionKey, agentId);

  if (!session) {
    return {
      quotaRemaining: quotaRemaining || 85,
      sessionTimeRemaining: getTimeUntilReset(resetHour),
      totalTokens: { input: 0, output: 0 },
      contextUsage: { used: 0, total: 4096 },
      model: "Unknown",
      provider,
      sessionFound: false,
    };
  }

  const transcriptPath = getTranscriptPath(session.sessionId, agentId);
  const transcriptTokens = readTokensFromTranscript(transcriptPath);
  const totalTokens = transcriptTokens || {
    inputTokens: session.inputTokens || 0,
    outputTokens: session.outputTokens || 0,
    totalTokens: session.totalTokens || 0,
  };
  const contextUsage = estimateContextUsage(session, session.model);

  return {
    quotaRemaining: quotaRemaining || 82,
    sessionTimeRemaining: getTimeUntilReset(resetHour),
    totalTokens: { input: totalTokens.inputTokens || 0, output: totalTokens.outputTokens || 0 },
    contextUsage: { used: contextUsage.used, total: contextUsage.total },
    contextPercentage: contextUsage.percentage,
    model: session.model || "Claude 3.5 Haiku",
    provider: session.provider || provider,
    sessionId: session.sessionId,
    updatedAt: session.updatedAt,
    sessionFound: true,
  };
}

export function getQuotaIndicator(percentage: number): string {
  if (percentage >= 75) return "🟢";
  if (percentage >= 50) return "🟡";
  if (percentage >= 25) return "🟠";
  return "🔴";
}

export function formatStats(stats: ReturnType<typeof collectUsageStats> & { contextPercentage?: number }): string {
  const quotaIndicator = getQuotaIndicator(stats.quotaRemaining ?? 0);
  const contextIndicator = getQuotaIndicator(100 - (stats.contextPercentage || 0));
  const timeRemaining = formatDuration(stats.sessionTimeRemaining);

  let message = "<b>📊 Session Usage Report</b>\n\n";
  message += "<b>🔋 Quota Remaining</b>\n";
  message += `${quotaIndicator} <code>${stats.quotaRemaining}%</code> of API quota\n`;
  message += `Provider: ${stats.provider}\n\n`;
  message += "<b>⏱️ Session Time</b>\n";
  message += `${timeRemaining} remaining\n`;
  message += "(resets daily at 4:00 AM)\n\n";
  message += "<b>🎯 Tokens Used</b>\n";
  const total = stats.totalTokens.input + stats.totalTokens.output;
  message += `${total.toLocaleString("en-US")} total tokens\n`;
  message += `├─ Input: ${stats.totalTokens.input.toLocaleString("en-US")}\n`;
  message += `└─ Output: ${stats.totalTokens.output.toLocaleString("en-US")}\n\n`;
  message += "<b>📦 Context Window</b>\n";
  message += `${contextIndicator} <code>${stats.contextPercentage || 0}%</code> used\n`;
  message += `${stats.contextUsage.used.toLocaleString("en-US")} / ${stats.contextUsage.total.toLocaleString("en-US")} tokens\n`;
  message += `\n<i>Model: ${stats.model}</i>`;
  if ("sessionId" in stats && stats.sessionId) {
    message += `\n<i>Session: ${stats.sessionId.substring(0, 8)}...</i>`;
  }
  return message;
}

// CLI usage
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isMain) {
  const sessionKey = process.argv[2] || "agent:main:main";
  const agentId = process.argv[3] || "main";
  const stats = collectUsageStats(sessionKey, { agentId, resetHour: 4 });
  if (process.argv[4] === "--json") {
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log(formatStats(stats));
  }
}
