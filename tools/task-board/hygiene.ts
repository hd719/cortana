#!/usr/bin/env npx tsx
import { spawnSync } from "node:child_process";

const res = spawnSync("npx", ["tsx", "tools/task-board/stale-detector.ts", ...process.argv.slice(2)], {
  stdio: "inherit",
});

process.exit(typeof res.status === "number" ? res.status : 1);
