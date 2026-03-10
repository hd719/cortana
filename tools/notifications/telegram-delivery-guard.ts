#!/usr/bin/env npx tsx

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  appendDigestEntry,
  deliveryDecisionFor,
  formatUserMessage,
  normalizeActionNeeded,
  normalizeSeverity,
  normalizeSystem,
  recordAggregate,
  routeOwner,
  type NotificationEnvelope,
  type NotificationSeverity,
} from "./focus-mode-policy.js";

const DEFAULT_TARGET = "8171372724";
const DEFAULT_ALERT_TYPE = "generic_alert";
const TELEGRAM_MAX_MESSAGE_LEN = 3500;
const DEFAULT_MAX_RETRIES = 3;
const DEDUPE_WINDOW_SECONDS = 300;

type GuardArgs = {
  message: string;
  target: string;
  alertType: string;
  dedupeKey: string;
  severity: NotificationSeverity;
  owner: string;
  system: string;
  actionNeeded: "now" | "soon" | "summary" | "none";
  sourceAgent?: string;
};

export function parseGuardArgs(argv: string[]): GuardArgs {
  const severity = normalizeSeverity(argv[5]);
  return {
    message: argv[0] ?? "",
    target: argv[1] || DEFAULT_TARGET,
    alertType: argv[3] || DEFAULT_ALERT_TYPE,
    dedupeKey: argv[4] ?? "",
    severity,
    owner: argv[6] || "monitor",
    system: normalizeSystem(argv[7], argv[3] || DEFAULT_ALERT_TYPE),
    actionNeeded: normalizeActionNeeded(argv[8], severity),
    sourceAgent: argv[9] || undefined,
  };
}

export function chunkMessage(message: string, maxLen = TELEGRAM_MAX_MESSAGE_LEN): string[] {
  if (message.length <= maxLen) return [message];

  const chunks: string[] = [];
  const lines = message.split(/\r?\n/);
  let current = "";

  const pushCurrent = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const line of lines) {
    const candidate = current.length === 0 ? line : `${current}\n${line}`;
    if (candidate.length <= maxLen) {
      current = candidate;
      continue;
    }

    pushCurrent();

    if (line.length <= maxLen) {
      current = line;
      continue;
    }

    for (let i = 0; i < line.length; i += maxLen) {
      chunks.push(line.slice(i, i + maxLen));
    }
  }

  pushCurrent();
  return chunks;
}

function sanitizeKey(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function shouldDedupe(dedupeKey: string): boolean {
  if (!dedupeKey) return false;

  const dedupeDir = path.join(os.homedir(), ".openclaw", "tmp", "telegram-guard");
  fs.mkdirSync(dedupeDir, { recursive: true });

  const marker = path.join(dedupeDir, `${sanitizeKey(dedupeKey)}.ts`);
  const now = Math.floor(Date.now() / 1000);

  if (fs.existsSync(marker)) {
    const lastRaw = fs.readFileSync(marker, "utf8").trim();
    const last = Number.parseInt(lastRaw, 10);
    if (Number.isFinite(last) && now - last < DEDUPE_WINDOW_SECONDS) {
      return true;
    }
  }

  fs.writeFileSync(marker, String(now));
  return false;
}

function sendChunk(target: string, chunk: string): { ok: boolean; stderr: string } {
  const proc = spawnSync(
    "openclaw",
    ["message", "send", "--channel", "telegram", "--target", target, "--message", chunk, "--json"],
    { encoding: "utf8" }
  );

  return {
    ok: (proc.status ?? 1) === 0,
    stderr: (proc.stderr ?? proc.stdout ?? "").trim(),
  };
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sendWithRetries(target: string, chunks: string[], maxRetries = DEFAULT_MAX_RETRIES): void {
  for (let idx = 0; idx < chunks.length; idx += 1) {
    const chunk = chunks[idx];
    let attempt = 0;
    while (attempt < maxRetries) {
      const res = sendChunk(target, chunk);
      if (res.ok) break;
      attempt += 1;
      if (attempt >= maxRetries) {
        throw new Error(`failed sending chunk ${idx + 1}/${chunks.length}: ${res.stderr || "unknown error"}`);
      }
      sleep(Math.min(2500, 400 * 2 ** (attempt - 1)));
    }
  }
}

export function run(argv: string[]): number {
  const args = parseGuardArgs(argv);

  if (!args.message) {
    console.error("[telegram-delivery-guard] missing message argument");
    return 1;
  }

  const envelope: NotificationEnvelope = {
    message: args.message,
    target: args.target,
    alertType: args.alertType,
    dedupeKey: args.dedupeKey || `${args.alertType}:${args.system}`,
    severity: args.severity,
    owner: routeOwner(args.owner, args.system),
    system: args.system,
    actionNeeded: args.actionNeeded,
    sourceAgent: args.sourceAgent,
  };

  const aggregate = recordAggregate(envelope);
  const finalMessage = formatUserMessage(envelope, aggregate);
  const decision = deliveryDecisionFor(envelope.severity);

  if (decision === "silent") {
    console.log(`[telegram-delivery-guard] suppressed (${envelope.alertType}) severity=${envelope.severity} system=${envelope.system}`);
    return 0;
  }

  if (decision === "digest") {
    const file = appendDigestEntry(envelope);
    console.log(`[telegram-delivery-guard] queued (${envelope.alertType}) severity=${envelope.severity} owner=${envelope.owner} file=${file}`);
    return 0;
  }

  if (shouldDedupe(envelope.dedupeKey)) {
    console.log(`[telegram-delivery-guard] deduped (${envelope.alertType}) key=${envelope.dedupeKey}`);
    return 0;
  }

  const chunks = chunkMessage(finalMessage);
  sendWithRetries(envelope.target, chunks);

  console.log(
    `[telegram-delivery-guard] sent (${envelope.alertType}) severity=${envelope.severity} owner=${envelope.owner} system=${envelope.system} to ${envelope.target} chunks=${chunks.length}`
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run(process.argv.slice(2)));
}
