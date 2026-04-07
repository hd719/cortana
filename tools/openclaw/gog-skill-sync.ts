#!/usr/bin/env npx tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sourceRepoRoot } from "../lib/paths.js";

export const DEFAULT_SOURCE_SKILL = path.join(sourceRepoRoot(), "skills", "gog", "SKILL.md");

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

export function findInstalledOpenClawGogSkillPaths(globalRoot = path.join(os.homedir(), "Library", "pnpm", "global")): string[] {
  if (!isDirectory(globalRoot)) return [];
  const targets: string[] = [];
  for (const entry of fs.readdirSync(globalRoot)) {
    const pnpmDir = path.join(globalRoot, entry, ".pnpm");
    if (!isDirectory(pnpmDir)) continue;
    for (const pkg of fs.readdirSync(pnpmDir)) {
      if (!pkg.startsWith("openclaw@")) continue;
      const skillPath = path.join(pnpmDir, pkg, "node_modules", "openclaw", "skills", "gog", "SKILL.md");
      if (fs.existsSync(skillPath)) targets.push(skillPath);
    }
  }
  return targets.sort();
}

export function syncGogSkillTargets(sourcePath = DEFAULT_SOURCE_SKILL, targetPaths = findInstalledOpenClawGogSkillPaths()): {
  changed: boolean;
  updated: string[];
  checked: string[];
} {
  const source = fs.readFileSync(sourcePath, "utf8");
  const updated: string[] = [];
  const checked: string[] = [];

  for (const targetPath of targetPaths) {
    checked.push(targetPath);
    const current = fs.readFileSync(targetPath, "utf8");
    if (current === source) continue;
    fs.writeFileSync(targetPath, source, "utf8");
    updated.push(targetPath);
  }

  return {
    changed: updated.length > 0,
    updated,
    checked,
  };
}

function parseArgs(argv: string[]) {
  const args = {
    source: DEFAULT_SOURCE_SKILL,
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--source") args.source = argv[++i]!;
    else if (argv[i] === "--check") args.check = true;
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const targets = findInstalledOpenClawGogSkillPaths();
  const result = syncGogSkillTargets(args.source, targets);

  if (args.check) {
    const ok = result.updated.length === 0;
    console.log(ok ? "IN_SYNC" : "DRIFT");
    process.exit(ok ? 0 : 1);
  }

  if (targets.length === 0) {
    console.log("NO_TARGETS");
    return;
  }

  console.log(result.changed ? `SYNCED ${result.updated.length}` : "NO_CHANGE");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
