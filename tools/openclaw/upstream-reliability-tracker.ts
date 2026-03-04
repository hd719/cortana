#!/usr/bin/env npx tsx
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

interface Workaround {
  name: string;
  path: string;
}

interface Issue {
  key: string;
  title: string;
  url: string;
  upstream_issue_number?: number;
  local_workarounds: Workaround[];
}

interface Watchlist {
  repo: string;
  last_reviewed_at: string;
  issues: Issue[];
}

const root = "/Users/hd/openclaw";
const watchlistPath = path.join(root, "config/upstream-reliability-watchlist.json");

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    json: args.includes("--json"),
    markdown: args.includes("--markdown"),
  };
}

function getIssueState(repo: string, issueNumber?: number): "open" | "closed" | "unknown" {
  if (!issueNumber) return "unknown";
  try {
    const out = execFileSync(
      "gh",
      ["issue", "view", String(issueNumber), "--repo", repo, "--json", "state", "-q", ".state"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();

    if (out.toUpperCase() === "OPEN") return "open";
    if (out.toUpperCase() === "CLOSED") return "closed";
    return "unknown";
  } catch {
    return "unknown";
  }
}

function main() {
  const args = parseArgs();
  const raw = fs.readFileSync(watchlistPath, "utf8");
  const watchlist = JSON.parse(raw) as Watchlist;

  const rows = watchlist.issues.flatMap((issue) => {
    const issueState = getIssueState(watchlist.repo, issue.upstream_issue_number);
    return issue.local_workarounds.map((w) => {
      const absolute = path.join(root, w.path);
      const exists = fs.existsSync(absolute);
      return {
        issue_key: issue.key,
        issue_title: issue.title,
        issue_url: issue.url,
        upstream_issue_number: issue.upstream_issue_number ?? null,
        upstream_state: issueState,
        workaround: w.name,
        workaround_path: w.path,
        file_exists: exists,
      };
    });
  });

  const missingPaths = rows.filter((r) => !r.file_exists);
  const missingIssueLinks = watchlist.issues.filter((i) => !i.upstream_issue_number).map((i) => i.key);
  const retirementCandidates = rows.filter((r) => r.file_exists && r.upstream_state === "closed");

  const summary = {
    repo: watchlist.repo,
    last_reviewed_at: watchlist.last_reviewed_at,
    issue_count: watchlist.issues.length,
    workaround_count: rows.length,
    missing_path_count: missingPaths.length,
    missing_issue_link_count: missingIssueLinks.length,
    retirement_candidate_count: retirementCandidates.length,
    missing_issue_links: missingIssueLinks,
    retirement_candidates: retirementCandidates,
    rows,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else if (args.markdown) {
    console.log(`# Upstream Reliability Digest (${summary.repo})`);
    console.log(`- Last reviewed: ${summary.last_reviewed_at}`);
    console.log(`- Issues tracked: ${summary.issue_count}`);
    console.log(`- Local workarounds tracked: ${summary.workaround_count}`);
    console.log(`- Missing workaround paths: ${summary.missing_path_count}`);
    console.log(`- Missing upstream issue links: ${summary.missing_issue_link_count}`);
    console.log(`- Retirement candidates: ${summary.retirement_candidate_count}`);
    if (summary.missing_issue_links.length > 0) {
      console.log(`- Missing issue keys: ${summary.missing_issue_links.join(", ")}`);
    }
    console.log("\n## Details");
    for (const r of rows) {
      const state = String(r.upstream_state).toUpperCase();
      const number = r.upstream_issue_number ? `#${r.upstream_issue_number}` : "(unlinked)";
      console.log(`- [${r.file_exists ? "OK" : "MISSING"}] ${r.issue_key} ${number} [${state}] :: ${r.workaround} (${r.workaround_path})`);
    }
  } else {
    console.log(`Upstream reliability tracker (${summary.repo})`);
    console.log(`Last reviewed: ${summary.last_reviewed_at}`);
    console.log(
      `Issues: ${summary.issue_count} | Workarounds: ${summary.workaround_count} | Missing paths: ${summary.missing_path_count} | Missing issue links: ${summary.missing_issue_link_count} | Retirement candidates: ${summary.retirement_candidate_count}`,
    );
    for (const r of rows) {
      const state = String(r.upstream_state).toUpperCase();
      const issueRef = r.upstream_issue_number ? `#${r.upstream_issue_number}` : "(unlinked)";
      console.log(`- [${r.file_exists ? "OK" : "MISSING"}] ${r.issue_key} ${issueRef}/${state} :: ${r.workaround} (${r.workaround_path})`);
    }
  }

  if (missingPaths.length > 0) process.exit(2);
}

main();
