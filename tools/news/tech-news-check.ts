#!/usr/bin/env npx tsx
import { spawnSync } from "node:child_process";

const sources = [
  "https://techcrunch.com/feed/",
  "https://hnrss.org/frontpage",
];

const topItems: string[] = [];
for (const src of sources) {
  const out = spawnSync("bash", ["-lc", `curl -fsSL ${JSON.stringify(src)} | rg -o '<title>[^<]+' | sed 's/<title>//' | tail -n +2 | head -n 3`], {
    encoding: "utf8",
  });
  if (out.status === 0) {
    const lines = (out.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    topItems.push(...lines.map((line) => `[${src}] ${line}`));
  }
}

if (topItems.length === 0) {
  console.log(JSON.stringify({ ok: false, reason: "no_sources_available" }));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, headlines: topItems.slice(0, 6) }, null, 2));
