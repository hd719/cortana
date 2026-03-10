#!/usr/bin/env npx tsx

import { getNotificationMode, setNotificationMode } from "./focus-mode-policy.js";

const cmd = process.argv[2] ?? "status";

if (cmd === "status") {
  console.log(JSON.stringify(getNotificationMode(), null, 2));
  process.exit(0);
}

if (cmd === "quiet") {
  const reason = process.argv[3] ?? "quiet mode enabled";
  const allowBelow = (process.argv[4] as "P0" | "P1" | "P2" | "P3" | undefined) ?? "P1";
  const file = setNotificationMode("quiet", reason, allowBelow);
  console.log(JSON.stringify({ ok: true, mode: "quiet", allowBelow, reason, file }, null, 2));
  process.exit(0);
}

if (cmd === "normal") {
  const file = setNotificationMode("normal", process.argv[3] ?? "quiet mode disabled", "P1");
  console.log(JSON.stringify({ ok: true, mode: "normal", file }, null, 2));
  process.exit(0);
}

console.error("Usage: notification-mode.ts <status|quiet [reason] [allowBelow=P1]|normal [reason]>");
process.exit(2);
