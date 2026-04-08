#!/usr/bin/env npx tsx

import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { readJsonFile } from "../lib/json-file.js";
import { createApprovalRequest, recordApprovalDecision } from "../lib/mission-control-ledger.js";

const DEFAULT_CONFIG = path.join(os.homedir(), ".openclaw", "openclaw.json");

const HIGH_RISK_KEYWORDS = [
  "external email",
  "send email",
  "git push",
  "push to main",
  "public post",
  "tweet",
  "x post",
  "linkedin",
];

type ApprovalResult = {
  approved: boolean;
  reason: string;
  approvalId?: string;
};

async function httpJson(url: string, payload?: Record<string, unknown>): Promise<any> {
  const init: RequestInit = payload
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    : { method: "GET" };
  const res = await fetch(url, init);
  const data = await res.json();
  return data;
}

function loadOpenclawConfig(configPath: string): Record<string, any> {
  const cfg = readJsonFile<Record<string, any>>(configPath);
  if (!cfg) {
    throw new Error(`Unable to read config at ${configPath}`);
  }
  return cfg;
}

function approvalRouting(configPath: string): { accountId: string; chatId: string | null } {
  const cfg = loadOpenclawConfig(configPath);
  const approvals = cfg?.channels?.telegram?.systemRouting?.approvals;
  const accountId = String(approvals?.accountId || "default");
  const chatId = approvals?.chatId !== undefined && approvals?.chatId !== null ? String(approvals.chatId) : null;
  return { accountId, chatId };
}

function telegramToken(configPath: string): string {
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  if (envToken) return envToken;
  const cfg = loadOpenclawConfig(configPath);
  const routing = approvalRouting(configPath);
  const token = cfg?.channels?.telegram?.botToken
    ?? cfg?.channels?.telegram?.accounts?.[routing.accountId]?.botToken
    ?? cfg?.channels?.telegram?.accounts?.default?.botToken;
  if (!token) {
    throw new Error(
      `Telegram bot token not found. Set TELEGRAM_BOT_TOKEN or configure channels.telegram.accounts.${routing.accountId}.botToken in ~/.openclaw/openclaw.json`,
    );
  }
  return String(token);
}

function configuredChatId(configPath: string): string | null {
  if (process.env.TELEGRAM_CHAT_ID) return String(process.env.TELEGRAM_CHAT_ID);
  const routing = approvalRouting(configPath);
  if (routing.chatId) return routing.chatId;
  const cfg = loadOpenclawConfig(configPath);
  const telegram = cfg?.channels?.telegram;
  const allowFrom = Array.isArray(telegram?.allowFrom) ? telegram.allowFrom : [];
  const candidate = allowFrom.find((value: unknown) => value !== undefined && value !== null && String(value).trim());
  return candidate !== undefined ? String(candidate) : null;
}

async function inferChatId(token: string): Promise<string | null> {
  const res = await httpJson(`https://api.telegram.org/bot${token}/getUpdates`);
  if (!res?.ok) return null;
  const result = Array.isArray(res.result) ? res.result : [];
  for (let i = result.length - 1; i >= 0; i -= 1) {
    const upd = result[i];
    const msg = upd?.message ?? upd?.callback_query?.message;
    const chatId = msg?.chat?.id;
    if (chatId !== undefined && chatId !== null) return String(chatId);
  }
  return null;
}

async function sendApprovalMessage(
  token: string,
  chatId: string,
  actionDesc: string,
  risk: string,
  approvalId: string,
): Promise<number> {
  const text =
    `🛑 Approval required\n` +
    `Risk: ${risk.toUpperCase()}\n` +
    `Action: ${actionDesc}\n\n` +
    `Request ID: ${approvalId}\n` +
    "Choose Approve or Reject.";
  const payload = {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `approve:${approvalId}` },
          { text: "❌ Reject", callback_data: `reject:${approvalId}` },
        ],
      ],
    },
  };
  const res = await httpJson(`https://api.telegram.org/bot${token}/sendMessage`, payload);
  if (!res?.ok) throw new Error(`Telegram sendMessage failed: ${JSON.stringify(res)}`);
  return Number(res.result?.message_id ?? 0);
}

async function answerCallback(token: string, callbackQueryId: string, text: string): Promise<void> {
  const payload = { callback_query_id: callbackQueryId, text, show_alert: false };
  await httpJson(`https://api.telegram.org/bot${token}/answerCallbackQuery`, payload);
}

async function stripKeyboard(token: string, chatId: string, messageId: number, suffix: string): Promise<void> {
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  };
  await httpJson(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, payload);
  if (suffix) {
    await httpJson(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: suffix });
  }
}

async function pollDecision(
  token: string,
  approvalId: string,
  timeoutSec: number,
  startOffset = 0,
): Promise<[boolean | null, string, number]> {
  const deadline = Date.now() + timeoutSec * 1000;
  let offset = startOffset;

  while (Date.now() < deadline) {
    const wait = Math.min(25, Math.max(1, Math.floor((deadline - Date.now()) / 1000)));
    let url = `https://api.telegram.org/bot${token}/getUpdates?timeout=${wait}&allowed_updates=${encodeURIComponent(
      JSON.stringify(["callback_query"]),
    )}`;
    if (offset) url += `&offset=${offset}`;

    const res = await httpJson(url);
    if (!res?.ok) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const updates = Array.isArray(res.result) ? res.result : [];
    for (const upd of updates) {
      offset = Math.max(offset, Number(upd?.update_id ?? 0) + 1);
      const cb = upd?.callback_query;
      if (!cb) continue;
      const data = String(cb?.data ?? "");
      if (data === `approve:${approvalId}`) {
        await answerCallback(token, cb.id, "Approved");
        return [true, "approved", offset];
      }
      if (data === `reject:${approvalId}`) {
        await answerCallback(token, cb.id, "Rejected");
        return [false, "rejected", offset];
      }
    }
  }

  return [null, "timeout", offset];
}

function isHighRisk(actionDesc: string, risk: string): boolean {
  const r = (risk || "").trim().toLowerCase();
  if (r === "high" || r === "critical" || r === "p1") return true;
  const low = (actionDesc || "").trim().toLowerCase();
  return HIGH_RISK_KEYWORDS.some((k) => low.includes(k));
}

export async function requestApproval(
  actionDesc: string,
  risk: string,
  timeoutS = 300,
  chatId?: string | null,
  token?: string | null,
  configPath = DEFAULT_CONFIG,
): Promise<ApprovalResult> {
  if (!isHighRisk(actionDesc, risk)) {
    return { approved: true, reason: "not_high_risk" };
  }

  const approvalId = createApprovalRequest({
    agentId: process.env.OPENCLAW_AGENT_ID ?? process.env.AGENT_ID ?? "cortana",
    actionType: "high_risk_action",
    proposal: {
      action: actionDesc,
      risk,
      source: "approval-gate",
    },
    rationale: "High-risk action requires explicit Telegram approval before execution.",
    riskLevel: risk || "high",
    autoApprovable: false,
    status: "pending",
    expiresAtHours: Math.max(1, Math.ceil(timeoutS / 3600)),
    resumePayload: { action: actionDesc, risk },
  });

  const tok = token ?? telegramToken(configPath);
  let resolvedChat: string | null = chatId ?? configuredChatId(configPath);
  if (!resolvedChat) {
    try {
      resolvedChat = await inferChatId(tok);
    } catch {
      recordApprovalDecision(approvalId, "rejected", "system", "chat_lookup_failed");
      return { approved: false, reason: "chat_lookup_failed", approvalId };
    }
  }
  if (!resolvedChat) {
    recordApprovalDecision(approvalId, "rejected", "system", "no_chat_id");
    return { approved: false, reason: "no_chat_id", approvalId };
  }

  let msgId = 0;
  try {
    msgId = await sendApprovalMessage(tok, resolvedChat, actionDesc, risk, approvalId);
  } catch {
    recordApprovalDecision(approvalId, "rejected", "system", "telegram_send_failed");
    return { approved: false, reason: "telegram_send_failed", approvalId };
  }

  const [decided] = await pollDecision(tok, approvalId, timeoutS);

  if (decided === true) {
    recordApprovalDecision(approvalId, "approved", "user", "telegram_approve");
    await stripKeyboard(tok, resolvedChat, msgId, `✅ Approved: ${actionDesc}`);
    return { approved: true, reason: "approved", approvalId };
  }

  if (decided === false) {
    recordApprovalDecision(approvalId, "rejected", "user", "telegram_reject");
    await stripKeyboard(tok, resolvedChat, msgId, `❌ Rejected: ${actionDesc}`);
    return { approved: false, reason: "rejected", approvalId };
  }

  recordApprovalDecision(approvalId, "expired", "system", "timeout");
  await stripKeyboard(tok, resolvedChat, msgId, `⏱️ Approval timed out: ${actionDesc}`);
  return { approved: false, reason: "timeout", approvalId };
}

function parseArgs(argv: string[]) {
  const args = {
    action: "",
    risk: "",
    timeout: 300,
    chatId: null as string | null,
    config: DEFAULT_CONFIG,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--action") {
      args.action = argv[++i] ?? "";
    } else if (a === "--risk") {
      args.risk = argv[++i] ?? "";
    } else if (a === "--timeout") {
      args.timeout = Number.parseInt(argv[++i] ?? "300", 10);
    } else if (a === "--chat-id") {
      args.chatId = argv[++i] ?? null;
    } else if (a === "--config") {
      args.config = argv[++i] ?? args.config;
    }
  }

  return args;
}

export async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.action || !args.risk) {
    console.error("--action and --risk are required");
    return 2;
  }

  const result = await requestApproval(args.action, args.risk, args.timeout, args.chatId, null, args.config);

  if (result.approved) {
    console.log("APPROVED");
    return 0;
  }

  console.log(`DENIED (${result.reason})`);
  return 1;
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(entry).href === import.meta.url;
}

if (isEntrypoint()) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
