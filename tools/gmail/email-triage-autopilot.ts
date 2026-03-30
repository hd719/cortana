#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";
import path from "node:path";
import db from "../lib/db.ts";

const { withPostgresPath } = db as { withPostgresPath: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv };
const DEFAULT_PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql";
const REPO_ROOT = process.env.CORTANA_SOURCE_REPO ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const DEFAULT_TELEGRAM_GUARD = path.join(REPO_ROOT, "tools", "notifications", "telegram-delivery-guard.sh");
const INBOX_EXECUTION_SCRIPT = path.join(REPO_ROOT, "tools", "email", "inbox_to_execution.ts");

type EmailRow = {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  date: unknown;
  gmailUrl: string;
  bucket: "urgent" | "action" | "read_later";
};

function sqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function run(cmd: string, args: string[], env = process.env): { status: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
  return { status: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function classifyText(text: string): EmailRow["bucket"] {
  const t = text.toLowerCase();
  if (/urgent|asap|immediately|today|deadline|payment due|security alert|account locked|interview|offer|expiring/.test(t)) return "urgent";
  if (/please review|action required|follow up|reply needed|todo|can you|need you|meeting request/.test(t)) return "action";
  return "read_later";
}

function normalize(raw: unknown): EmailRow[] {
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as any).threads)
      ? (raw as any).threads
      : raw && typeof raw === "object" && Array.isArray((raw as any).messages)
        ? (raw as any).messages
        : [];

  return items.map((it: any) => {
    const id = String(it?.id ?? it?.messageId ?? it?.threadId ?? "");
    const threadId = String(it?.threadId ?? it?.id ?? "");
    const from = String(it?.from ?? it?.sender ?? "Unknown");
    const subject = String(it?.subject ?? "(no subject)");
    const snippet = String(it?.snippet ?? it?.preview ?? "");
    const date = it?.date ?? it?.internalDate ?? null;
    const gmailUrl = String(it?.gmailUrl ?? (id ? `https://mail.google.com/mail/u/0/#inbox/${id}` : ""));
    const bucket = classifyText(`${from} ${subject} ${snippet}`);
    return { id, threadId, from, subject, snippet, date, gmailUrl, bucket };
  });
}

async function main(): Promise<void> {
  const account = process.env.GOG_ACCOUNT || "hameldesai3@gmail.com";
  const db = process.env.CORTANA_DB || "cortana";
  const maxEmails = process.env.TRIAGE_MAX_EMAILS || "15";
  const lookback = process.env.TRIAGE_QUERY || "is:unread newer_than:3d";
  const sendTelegram = process.env.TRIAGE_SEND_TELEGRAM || "0";
  const runInboxExecution = process.env.TRIAGE_RUN_INBOX_EXECUTION || "1";
  const resolvedPsqlBin = process.env.PSQL_BIN || DEFAULT_PSQL_BIN;
  const triageEnv = {
    ...withPostgresPath(process.env),
    PSQL_BIN: resolvedPsqlBin,
  };

  const rawRes = run("gog", ["--account", account, "gmail", "search", lookback, "--max", maxEmails, "--json"]);
  let rawText = rawRes.status === 0 ? rawRes.out : "[]";
  if (!rawText || rawText.trim() === "null") rawText = "[]";

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    console.log("email-triage: invalid gog json");
    process.exit(1);
  }

  const classified = normalize(parsed);
  const urgentCount = classified.filter((x) => x.bucket === "urgent").length;
  const actionCount = classified.filter((x) => x.bucket === "action").length;
  const laterCount = classified.filter((x) => x.bucket === "read_later").length;

  let created = 0;
  for (const row of classified) {
    if (row.bucket !== "urgent" && row.bucket !== "action") continue;

    const escId = sqlEscape(row.id);
    const existing = run(
      resolvedPsqlBin,
      [db, "-t", "-A", "-c", `SELECT id FROM cortana_tasks WHERE status IN ('ready','in_progress') AND metadata->>'gmail_id'='${escId}' LIMIT 1;`],
      triageEnv
    ).out.trim();
    if (existing.replace(/ /g, "")) continue;

    const prio = row.bucket === "urgent" ? 1 : 2;
    const title = `Email: ${row.subject}`;
    const desc = `From: ${row.from}\n\n${row.snippet}\n\nOpen: ${row.gmailUrl}`;

    const sql = `INSERT INTO cortana_tasks (title, description, priority, auto_executable, execution_plan, source, status, metadata)
VALUES (
  '${sqlEscape(title)}',
  '${sqlEscape(desc)}',
  ${prio},
  FALSE,
  'Review and respond to this email manually. No auto-send.',
  'email-triage-autopilot',
  'ready',
  jsonb_build_object(
    'gmail_id','${escId}',
    'from','${sqlEscape(row.from)}',
    'subject','${sqlEscape(row.subject)}',
    'snippet','${sqlEscape(row.snippet)}',
    'url','${sqlEscape(row.gmailUrl)}',
    'triage_bucket','${row.bucket}'
  )
);`;
    const ins = run(resolvedPsqlBin, [db, "-v", "ON_ERROR_STOP=1", "-c", sql], triageEnv);
    if (ins.status === 0) created += 1;
  }

  const top = classified
    .filter((x) => x.bucket === "urgent" || x.bucket === "action")
    .slice(0, 8)
    .map((x, i) => `${i + 1}. [${x.bucket}] ${x.subject} — ${x.from}`)
    .join("\n");

  let digest = `📧 Email Triage Digest\n\n• Unread scanned: ${classified.length}\n• Urgent: ${urgentCount}\n• Action: ${actionCount}\n• Read later: ${laterCount}\n• Tasks created: ${created}\n`;
  if (top) digest += `\nTop urgent/action:\n${top}\n`;
  digest += `\n(Guardrail: no outbound email actions performed.)`;

  console.log(digest);

  if (runInboxExecution === "1") {
    const exists = run("test", ["-f", INBOX_EXECUTION_SCRIPT]);
    if (exists.status === 0) {
      const inbox = run("npx", ["tsx", INBOX_EXECUTION_SCRIPT, "--output-json"], triageEnv);
      if (inbox.out.trim()) {
        try {
          const data = JSON.parse(inbox.out);
          const orphan = data?.stats?.orphan ?? 0;
          const stale = data?.stats?.stale ?? 0;
          console.log(`\nInbox→Execution:\n• Stale commitments: ${stale}\n• Orphan risk: ${orphan}`);
        } catch {
          // ignore parse issues like bash version
        }
      }
    }
  }

  if (sendTelegram === "1") {
    const guardScript = process.env.TELEGRAM_DELIVERY_GUARD || DEFAULT_TELEGRAM_GUARD;
    const target = process.env.TELEGRAM_TARGET || "8171372724";
    run(guardScript, [digest, target, "email_triage_digest"], triageEnv);
  }
}

main();
