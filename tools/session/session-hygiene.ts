#!/usr/bin/env npx tsx

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

type SessionEntry = {
  sessionFile?: string;
  updatedAt?: number;
};

type SessionStore = Record<string, SessionEntry>;

type Policy = {
  agent: string;
  thresholdKb: number;
  matchKey: (key: string) => boolean;
};

type Candidate = {
  agent: string;
  key: string | null;
  sessionFile: string;
  sizeBytes: number;
  archivedFile: string;
  reason: "tracked" | "orphan";
};

type Report = {
  ok: true;
  dryRun: boolean;
  cleanedCount: number;
  candidates: Candidate[];
};

const DEFAULT_THRESHOLD_KB = 400;

const POLICIES: Policy[] = [
  {
    agent: "main",
    thresholdKb: DEFAULT_THRESHOLD_KB,
    matchKey: () => true,
  },
  {
    agent: "monitor",
    thresholdKb: DEFAULT_THRESHOLD_KB,
    matchKey: (key) => key === "agent:monitor:main" || key.startsWith("agent:monitor:telegram:direct:"),
  },
];

function parseArgs(argv: string[]) {
  return {
    dryRun: argv.includes("--dry-run"),
    json: argv.includes("--json"),
  };
}

function getSessionsRoot(agent: string) {
  return path.join(os.homedir(), ".openclaw", "agents", agent, "sessions");
}

function getStorePath(agent: string) {
  return path.join(getSessionsRoot(agent), "sessions.json");
}

function loadStore(agent: string): SessionStore {
  const storePath = getStorePath(agent);
  if (!fs.existsSync(storePath)) return {};
  const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as unknown;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as SessionStore) : {};
}

function archivePathFor(sessionFile: string, now = new Date()) {
  return `${sessionFile}.reset.${now.toISOString().replace(/:/g, "-")}`;
}

export function findCandidates(now = new Date()): Candidate[] {
  const candidates: Candidate[] = [];

  for (const policy of POLICIES) {
    const sessionsDir = getSessionsRoot(policy.agent);
    const thresholdBytes = policy.thresholdKb * 1024;
    const store = loadStore(policy.agent);
    const referenced = new Set<string>();

    for (const entry of Object.values(store)) {
      const sessionFile = entry?.sessionFile;
      if (!sessionFile) continue;
      referenced.add(path.resolve(sessionFile));
    }

    for (const [key, entry] of Object.entries(store)) {
      if (!policy.matchKey(key)) continue;
      const sessionFile = entry?.sessionFile;
      if (!sessionFile || !fs.existsSync(sessionFile)) continue;
      const sizeBytes = fs.statSync(sessionFile).size;
      if (sizeBytes <= thresholdBytes) continue;
      candidates.push({
        agent: policy.agent,
        key,
        sessionFile,
        sizeBytes,
        archivedFile: archivePathFor(sessionFile, now),
        reason: "tracked",
      });
    }

    if (!fs.existsSync(sessionsDir)) continue;
    for (const entry of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".jsonl")) continue;
      const sessionFile = path.join(sessionsDir, entry.name);
      const resolved = path.resolve(sessionFile);
      if (referenced.has(resolved)) continue;
      const sizeBytes = fs.statSync(sessionFile).size;
      if (sizeBytes <= thresholdBytes) continue;
      candidates.push({
        agent: policy.agent,
        key: null,
        sessionFile,
        sizeBytes,
        archivedFile: archivePathFor(sessionFile, now),
        reason: "orphan",
      });
    }
  }

  return candidates.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

function writeStore(agent: string, store: SessionStore) {
  const storePath = getStorePath(agent);
  const tmpPath = `${storePath}.tmp`;
  const backupPath = `${storePath}.bak`;
  if (fs.existsSync(storePath)) fs.copyFileSync(storePath, backupPath);
  fs.writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, storePath);
}

export function applyCleanup(candidates: Candidate[], dryRun: boolean): Report {
  const stores = new Map<string, SessionStore>();
  const changedAgents = new Set<string>();
  for (const policy of POLICIES) stores.set(policy.agent, loadStore(policy.agent));

  if (!dryRun) {
    for (const candidate of candidates) {
      if (fs.existsSync(candidate.sessionFile)) {
        fs.renameSync(candidate.sessionFile, candidate.archivedFile);
      }
      if (candidate.key) {
        const store = stores.get(candidate.agent);
        if (store) {
          delete store[candidate.key];
          changedAgents.add(candidate.agent);
        }
      }
    }

    for (const [agent, store] of stores.entries()) {
      if (!changedAgents.has(agent)) continue;
      writeStore(agent, store);
    }
  }

  return {
    ok: true,
    dryRun,
    cleanedCount: candidates.length,
    candidates,
  };
}

export function formatReport(report: Report) {
  if (report.cleanedCount === 0) return "NO_REPLY";

  const lines = [
    `🧹 Session hygiene cleaned ${report.cleanedCount} oversized session${report.cleanedCount === 1 ? "" : "s"}.`,
    ...report.candidates.slice(0, 6).map((candidate) => {
      const sizeKb = Math.round(candidate.sizeBytes / 1024);
      const key = candidate.key ?? `${candidate.agent}:orphan`;
      return `- ${key} (${sizeKb} KB)`;
    }),
  ];

  if (report.candidates.length > 6) {
    lines.push(`- +${report.candidates.length - 6} more`);
  }

  return lines.join("\n");
}

export function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = applyCleanup(findCandidates(), args.dryRun);
  const output = args.json ? JSON.stringify(report) : formatReport(report);
  process.stdout.write(`${output}\n`);
  return 0;
}

const entryArg = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryArg) {
  process.exit(run());
}
