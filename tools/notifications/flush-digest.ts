#!/usr/bin/env npx tsx

import fs from "node:fs";
import { chunkMessage, sendWithRetries } from "./telegram-delivery-guard.js";
import { digestFileFor, formatUserLabel, type NotificationEnvelope } from "./focus-mode-policy.js";

const target = process.argv[2] ?? process.env.TELEGRAM_CHAT_ID ?? "8171372724";
const file = process.argv[3] ?? digestFileFor(new Date());

if (!fs.existsSync(file)) {
  console.log(JSON.stringify({ ok: true, sent: false, reason: "no_digest_file", file }));
  process.exit(0);
}

const rows = fs
  .readFileSync(file, "utf8")
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line) as NotificationEnvelope & { queuedAt?: string });

if (rows.length === 0) {
  console.log(JSON.stringify({ ok: true, sent: false, reason: "empty_digest", file }));
  process.exit(0);
}

const grouped = new Map<string, (NotificationEnvelope & { queuedAt?: string })[]>();
for (const row of rows) {
  const key = `${row.system}|${row.severity}`;
  grouped.set(key, [...(grouped.get(key) ?? []), row]);
}

const sections = Array.from(grouped.entries()).map(([key, items]) => {
  const sample = items[0];
  const header = formatUserLabel(sample);
  const body = items
    .slice(0, 8)
    .map((item) => `• ${String(item.message ?? "").replace(/\s+/g, " ").trim()}`)
    .join("\n");
  const extra = items.length > 8 ? `\n• … ${items.length - 8} more` : "";
  return `${header}\n${body}${extra}`;
});

const msg = `🧾 Notification Digest\nQueued items: ${rows.length}\n\n${sections.join("\n\n")}`;
sendWithRetries(target, chunkMessage(msg));
fs.rmSync(file, { force: true });
console.log(JSON.stringify({ ok: true, sent: true, count: rows.length, groups: grouped.size, file }));
