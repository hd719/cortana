#!/usr/bin/env npx tsx

import fs from "node:fs";
import { chunkMessage, sendWithRetries } from "./telegram-delivery-guard.js";
import { digestFileFor } from "./focus-mode-policy.js";

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
  .map((line) => JSON.parse(line) as Record<string, unknown>);

if (rows.length === 0) {
  console.log(JSON.stringify({ ok: true, sent: false, reason: "empty_digest", file }));
  process.exit(0);
}

const lines = rows.slice(0, 20).map((row) => `• [${String(row.owner ?? "ops")}/${String(row.alertType ?? "notice")}] ${String(row.message ?? "")}`);
const msg = `🧾 Focus Mode Digest\n${lines.join("\n")}`;
sendWithRetries(target, chunkMessage(msg));
fs.rmSync(file, { force: true });
console.log(JSON.stringify({ ok: true, sent: true, count: rows.length, file }));
