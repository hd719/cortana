#!/usr/bin/env npx tsx
import { spawnSync } from "node:child_process";

const passthroughArgs = process.argv.slice(2);
const args = passthroughArgs.length > 0 ? passthroughArgs : ["--min-confidence", "0.66", "--create-tasks"];

const res = spawnSync("npx", ["tsx", "tools/proactive/detect.ts", ...args], {
  stdio: "inherit",
});

process.exit(typeof res.status === "number" ? res.status : 1);
