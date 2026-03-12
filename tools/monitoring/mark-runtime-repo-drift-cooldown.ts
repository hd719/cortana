#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_PATH = path.join(os.homedir(), ".openclaw", "state", "runtime-repo-drift-cooldown.json");

function parseArgs(argv: string[]) {
  let label = "cron/jobs.json";
  let minutes = 60;
  let reason = "intentional runtime patch";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--label" && argv[i + 1]) label = argv[++i];
    else if (arg === "--minutes" && argv[i + 1]) minutes = Number(argv[++i]) || minutes;
    else if (arg === "--reason" && argv[i + 1]) reason = argv[++i];
  }

  return { label, minutes, reason };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let current: { entries?: Array<{ label: string; untilMs: number; reason?: string }> } = {};
  try {
    current = JSON.parse(fs.readFileSync(DEFAULT_PATH, "utf8"));
  } catch {
    current = {};
  }

  const now = Date.now();
  const entries = Array.isArray(current.entries) ? current.entries.filter((e) => e.untilMs > now && e.label !== args.label) : [];
  entries.push({ label: args.label, untilMs: now + args.minutes * 60_000, reason: args.reason });

  fs.mkdirSync(path.dirname(DEFAULT_PATH), { recursive: true });
  fs.writeFileSync(DEFAULT_PATH, `${JSON.stringify({ entries }, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, label: args.label, minutes: args.minutes, reason: args.reason }));
}

main();
