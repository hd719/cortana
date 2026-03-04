#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { getScriptDir } from "../lib/paths.js";

export type SignalAction = "BUY" | "WATCH" | "NO_BUY";
export type AlertSource = "CANSLIM" | "DipBuyer" | "Unknown";

export interface TradingSignal {
  ticker: string;
  score?: number;
  action: SignalAction;
  reason: string;
  entryPrice?: number;
  stopLoss?: number;
  source: AlertSource;
}

export interface CouncilVerdict {
  ticker: string;
  sessionId: string;
  approved: boolean;
  approveCount: number;
  totalVotes: number;
  avgConfidence: number;
  synthesis: string;
}

interface VotePayload {
  vote: "approve" | "reject" | "abstain";
  confidence: number;
  reasoning: string;
}

const PARTICIPANTS = ["risk-analyst", "momentum-analyst", "fundamentals-analyst"] as const;
const VOTER_MODEL = "openai-codex/gpt-5.1";
const SYNTHESIS_MODEL = "openai-codex/gpt-5.2-codex";

function jsonError(message: string): string {
  return JSON.stringify({ ok: false, error: message });
}

function usage(): void {
  console.log(`Usage:\n  trading-council.ts [--input <path>]\n\nReads trading alert text from --input file or stdin. Appends council verdicts for BUY signals.`);
}

function detectSource(text: string): AlertSource {
  if (/CANSLIM Scan/i.test(text)) return "CANSLIM";
  if (/Dip Buyer Scan/i.test(text)) return "DipBuyer";
  return "Unknown";
}

function parseNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseSignals(alertText: string): TradingSignal[] {
  const source = detectSource(alertText);
  const lines = alertText.split(/\r?\n/);
  const out: TradingSignal[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const m = line.match(/^•\s+([A-Z][A-Z0-9.-]*)\s+\((\d+)\/\d+\)\s+→\s+(BUY|WATCH|NO_BUY)(?:\s+\|\s+.+)?$/);
    if (!m) continue;

    const ticker = m[1];
    const score = Number(m[2]);
    const action = m[3] as SignalAction;
    const reason = (lines[i + 1] ?? "").trim();
    const entryMatch = reason.match(/Entry\s+\$([\d.]+)\s*\|\s*Stop\s+\$([\d.]+)/i);

    out.push({
      ticker,
      score: Number.isFinite(score) ? score : undefined,
      action,
      reason,
      entryPrice: parseNumber(entryMatch?.[1]),
      stopLoss: parseNumber(entryMatch?.[2]),
      source,
    });
  }

  return out;
}

function runTsx(file: string, args: string[]): string {
  const r = spawnSync("tsx", [file, ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(r.stderr || r.stdout || "command failed");
  }
  return (r.stdout || "").trim();
}

function runCodexPrompt(model: string, prompt: string): string {
  const r = spawnSync("codex", ["exec", "--model", model, prompt], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || "codex failed");
  return (r.stdout || "").trim();
}

function buildVoterPrompt(role: (typeof PARTICIPANTS)[number], signal: TradingSignal): string {
  return [
    `You are ${role}.`,
    "Return JSON only:",
    '{"vote":"approve|reject","confidence":0.00-1.00,"reasoning":"<=220 chars"}',
    `Strategy: ${signal.source}`,
    `Ticker: ${signal.ticker}`,
    `Action: ${signal.action}`,
    `Score: ${signal.score ?? "N/A"}/12`,
    `Entry: ${signal.entryPrice ?? "N/A"}`,
    `Stop: ${signal.stopLoss ?? "N/A"}`,
    `Signal note: ${signal.reason || "N/A"}`,
    role === "risk-analyst"
      ? "Focus: downside risk, position sizing, concentration."
      : role === "momentum-analyst"
        ? "Focus: trend, momentum, volume confirmation."
        : "Focus: valuation, earnings quality, sector conditions.",
  ].join("\n");
}

function parseVoteFromModel(text: string): VotePayload {
  const fallback: VotePayload = { vote: "reject", confidence: 0.45, reasoning: "Model parse fallback: insufficient structured output." };
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return fallback;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const vote = parsed.vote === "approve" ? "approve" : parsed.vote === "reject" ? "reject" : "abstain";
    const conf = Number(parsed.confidence);
    return {
      vote: vote === "abstain" ? "reject" : vote,
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.5,
      reasoning: String(parsed.reasoning || "No reasoning provided").slice(0, 300),
    };
  } catch {
    return fallback;
  }
}

function createSession(signal: TradingSignal): string {
  const scriptDir = getScriptDir(import.meta.url);
  const deliberate = path.join(scriptDir, "council-deliberate.ts");
  const title = `BUY signal: ${signal.ticker} via ${signal.source === "DipBuyer" ? "DipBuyer" : "CANSLIM"}`;
  const context = JSON.stringify({
    ticker: signal.ticker,
    score: signal.score,
    action: signal.action,
    entryPrice: signal.entryPrice,
    stopLoss: signal.stopLoss,
    reasoning: signal.reason,
    source: signal.source,
  });

  const out = runTsx(deliberate, [
    "--title", title,
    "--participants", PARTICIPANTS.join(","),
    "--context", context,
    "--expires", "5",
    "--initiator", "trading-council",
  ]);

  const parsed = JSON.parse(out);
  if (!parsed.ok || !parsed.session_id) throw new Error("Failed to create council session");
  return parsed.session_id as string;
}

function castVote(sessionId: string, voter: (typeof PARTICIPANTS)[number], signal: TradingSignal): VotePayload {
  const council = path.join(getScriptDir(import.meta.url), "council.ts");
  let vote = { vote: "reject", confidence: 0.5, reasoning: "Fallback reject due to voter model failure." } as VotePayload;

  try {
    vote = parseVoteFromModel(runCodexPrompt(VOTER_MODEL, buildVoterPrompt(voter, signal)));
  } catch {
    // keep fallback
  }

  runTsx(council, [
    "vote",
    "--session", sessionId,
    "--voter", voter,
    "--vote", vote.vote,
    "--confidence", vote.confidence.toFixed(2),
    "--reasoning", vote.reasoning,
    "--model", VOTER_MODEL,
  ]);

  return vote;
}

function oneLineSynthesis(signal: TradingSignal, approveCount: number, avgConfidence: number, votes: VotePayload[]): string {
  try {
    const prompt = [
      "Summarize this trading council decision in ONE sentence under 140 chars.",
      `Ticker: ${signal.ticker}`,
      `Approvals: ${approveCount}/3`,
      `Avg confidence: ${avgConfidence.toFixed(2)}`,
      `Votes: ${votes.map((v, i) => `${PARTICIPANTS[i]}=${v.vote}(${v.confidence.toFixed(2)}): ${v.reasoning}`).join(" | ")}`,
      "Output sentence only.",
    ].join("\n");
    return runCodexPrompt(SYNTHESIS_MODEL, prompt).split(/\r?\n/)[0]?.trim() || "Council synthesized a mixed signal.";
  } catch {
    return votes[0]?.reasoning || "Council synthesized a mixed signal.";
  }
}

export function shouldDeliberate(signal: TradingSignal): boolean {
  return signal.action === "BUY";
}

export function buildCouncilSessionArgs(signal: TradingSignal): string[] {
  const title = `BUY signal: ${signal.ticker} via ${signal.source === "DipBuyer" ? "DipBuyer" : "CANSLIM"}`;
  const context = JSON.stringify({
    ticker: signal.ticker,
    score: signal.score,
    action: signal.action,
    entryPrice: signal.entryPrice,
    stopLoss: signal.stopLoss,
    reasoning: signal.reason,
    source: signal.source,
  });

  return [
    "--title", title,
    "--participants", PARTICIPANTS.join(","),
    "--context", context,
    "--expires", "5",
    "--initiator", "trading-council",
  ];
}

export function renderOutput(originalAlert: string, verdicts: CouncilVerdict[]): string {
  if (!verdicts.length) return originalAlert;
  const verdictLines: string[] = ["", "Council Deliberation:"];
  for (const v of verdicts) {
    verdictLines.push(
      `• ${v.ticker}: 🏛️ Council: ${v.approved ? "APPROVED" : "REJECTED"} (${v.approveCount}/${v.totalVotes}, avg confidence ${v.avgConfidence.toFixed(2)})`,
    );
    verdictLines.push(`  ${v.synthesis}`);
  }
  return `${originalAlert}\n${verdictLines.join("\n")}`;
}

function parseInputArg(argv: string[]): { inputPath?: string } {
  const out: { inputPath?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--input") out.inputPath = argv[++i];
    else if (a === "-h" || a === "--help") { usage(); process.exit(0); }
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

function readInput(inputPath?: string): string {
  if (inputPath) return fs.readFileSync(inputPath, "utf8");
  if (!process.stdin.isTTY) return fs.readFileSync(0, "utf8");
  throw new Error("No input provided. Use --input or pipe alert text via stdin.");
}

export async function runTradingCouncil(alertText: string): Promise<{ output: string; verdicts: CouncilVerdict[]; signals: TradingSignal[] }> {
  const signals = parseSignals(alertText);
  const verdicts: CouncilVerdict[] = [];

  for (const signal of signals) {
    if (!shouldDeliberate(signal)) continue;

    const sessionId = createSession(signal);
    const votes = PARTICIPANTS.map((voter) => castVote(sessionId, voter, signal));

    const tallyScript = path.join(getScriptDir(import.meta.url), "council-tally.ts");
    const tallyOut = runTsx(tallyScript, ["--session", sessionId]);
    const tally = JSON.parse(tallyOut);
    const totals = tally?.summary?.totals || {};

    const approveCount = Number(totals.approve ?? 0);
    const totalVotes = Number(totals.total_votes ?? 0);
    const avgConfidence = Number(totals.avg_confidence ?? 0);
    const approved = String(tally?.summary?.outcome || "").toLowerCase() === "approved";

    verdicts.push({
      ticker: signal.ticker,
      sessionId,
      approved,
      approveCount,
      totalVotes,
      avgConfidence,
      synthesis: oneLineSynthesis(signal, approveCount, avgConfidence, votes),
    });
  }

  return { output: renderOutput(alertText, verdicts), verdicts, signals };
}

async function main(): Promise<void> {
  try {
    const { inputPath } = parseInputArg(process.argv.slice(2));
    const alertText = readInput(inputPath);
    const result = await runTradingCouncil(alertText);
    console.log(result.output);
  } catch (error) {
    console.log(jsonError((error as Error).message));
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
