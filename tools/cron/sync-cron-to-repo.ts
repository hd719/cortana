#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { resolveHomePath, resolveRepoPath } from "../lib/paths.js";

const runtimeJobs = resolveHomePath(".openclaw", "cron", "jobs.json");
const repoJobs = resolveRepoPath("config", "cron", "jobs.json");

if (!fs.existsSync(runtimeJobs)) {
  console.log('{"error":"runtime jobs.json missing"}');
  process.exit(1);
}

let alreadySynced = false;
if (fs.existsSync(repoJobs)) {
  const runtimeData = fs.readFileSync(runtimeJobs);
  const repoData = fs.readFileSync(repoJobs);
  alreadySynced = runtimeData.equals(repoData);
}

if (alreadySynced) {
  console.log('{"synced":false,"reason":"already in sync"}');
  process.exit(0);
}

fs.mkdirSync(path.dirname(repoJobs), { recursive: true });
fs.copyFileSync(runtimeJobs, repoJobs);
try {
  const stat = fs.statSync(runtimeJobs);
  fs.chmodSync(repoJobs, stat.mode);
} catch {
  // ignore permission copy issues
}

console.log('{"synced":true,"from":"runtime","to":"repo"}');
