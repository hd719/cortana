#!/usr/bin/env npx tsx

import { spawnSync } from "node:child_process";

export type IssueRepo = "cortana-foundry/cortana" | "cortana-foundry/cortana-external";

export type OperationalIssueInput = {
  title: string;
  summary: string;
  source: string;
  category?: string;
  severity?: "info" | "warning" | "critical";
  system?: string;
  evidence?: Record<string, unknown>;
  recommendedAction?: string;
  repoHint?: "cortana" | "cortana-external";
  labels?: string[];
  dedupeKey?: string;
};

export type IssueReportResult =
  | { status: "skipped"; reason: string; repo: IssueRepo }
  | { status: "dry-run"; repo: IssueRepo; title: string; body: string; labels: string[] }
  | { status: "existing"; repo: IssueRepo; url: string; title: string; labels: string[] }
  | { status: "created"; repo: IssueRepo; url: string; title: string; labels: string[] };

export type GitHubIssueClient = {
  findOpenIssue?(input: { repo: IssueRepo; title: string }): { url: string } | null;
  createIssue(input: { repo: IssueRepo; title: string; body: string; labels: string[] }): { url: string };
};

const CORTANA_REPO: IssueRepo = "cortana-foundry/cortana";
const EXTERNAL_REPO: IssueRepo = "cortana-foundry/cortana-external";

const EXTERNAL_PATTERN = /runtime|mission[- ]?control|external[- ]?service|market|whoop|schwab|deployed|service/i;
const CORTANA_PATTERN = /doctrine|cron|agent|memory|openclaw|policy|command[- ]?brain/i;
const HIGH_SIGNAL_PATTERN = /repeated cron failure|runtime service degraded|auth expired|human action|required|monitor regression|qa failure|test failure|degraded|reauth|oauth|credential/i;

export function routeIssue(input: OperationalIssueInput): IssueRepo {
  if (input.repoHint === "cortana-external") return EXTERNAL_REPO;
  if (input.repoHint === "cortana") return CORTANA_REPO;

  const haystack = `${input.title} ${input.summary} ${input.source} ${input.category ?? ""} ${input.system ?? ""}`;
  if (EXTERNAL_PATTERN.test(haystack)) return EXTERNAL_REPO;
  if (CORTANA_PATTERN.test(haystack)) return CORTANA_REPO;
  return CORTANA_REPO;
}

export function isHighSignalOperationalIssue(input: OperationalIssueInput): boolean {
  const haystack = `${input.title} ${input.summary} ${input.source} ${input.category ?? ""} ${input.system ?? ""}`;
  return HIGH_SIGNAL_PATTERN.test(haystack);
}

export function buildIssueLabels(input: OperationalIssueInput): string[] {
  const labels = new Set<string>(["openclaw", "ops"]);
  if (input.severity === "critical") labels.add("P1");
  if (input.category) labels.add(input.category.replace(/[^a-z0-9-]+/gi, "-").toLowerCase());
  for (const label of input.labels ?? []) {
    if (label.trim()) labels.add(label.trim());
  }
  return [...labels];
}

export function renderIssueBody(input: OperationalIssueInput): string {
  const evidence = input.evidence ? JSON.stringify(input.evidence, null, 2) : "{}";
  return [
    "## Summary",
    input.summary,
    "",
    "## Routing",
    `- Source: ${input.source}`,
    `- System: ${input.system ?? "unknown"}`,
    `- Category: ${input.category ?? "unknown"}`,
    `- Severity: ${input.severity ?? "warning"}`,
    "",
    "## Recommended Action",
    input.recommendedAction ?? "Investigate and fix the durable operational failure.",
    "",
    "## Evidence",
    "```json",
    evidence,
    "```",
  ].join("\n");
}

export class GhCliIssueClient implements GitHubIssueClient {
  findOpenIssue(input: { repo: IssueRepo; title: string }): { url: string } | null {
    const proc = spawnSync(
      "gh",
      ["issue", "list", "--repo", input.repo, "--state", "open", "--search", `${input.title} in:title`, "--json", "title,url", "--limit", "20"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (proc.status !== 0) return null;
    try {
      const rows = JSON.parse(proc.stdout || "[]") as Array<{ title?: string; url?: string }>;
      const match = rows.find((row) => row.title === input.title && row.url);
      return match?.url ? { url: match.url } : null;
    } catch {
      return null;
    }
  }

  createIssue(input: { repo: IssueRepo; title: string; body: string; labels: string[] }): { url: string } {
    const args = [
      "issue",
      "create",
      "--repo",
      input.repo,
      "--title",
      input.title,
      "--body",
      input.body,
    ];
    for (const label of input.labels) args.push("--label", label);

    const proc = spawnSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (proc.status !== 0) {
      throw new Error((proc.stderr || proc.stdout || "gh issue create failed").trim());
    }
    return { url: (proc.stdout || "").trim() };
  }
}

export function reportOperationalIssue(
  input: OperationalIssueInput,
  opts: { dryRun?: boolean; client?: GitHubIssueClient } = {},
): IssueReportResult {
  const repo = routeIssue(input);
  if (!isHighSignalOperationalIssue(input)) {
    return { status: "skipped", reason: "low_signal", repo };
  }

  const title = input.title.slice(0, 180);
  const body = renderIssueBody(input);
  const labels = buildIssueLabels(input);
  const dryRun = opts.dryRun ?? process.env.CORTANA_GITHUB_ISSUES_DRY_RUN === "1";

  if (dryRun) return { status: "dry-run", repo, title, body, labels };

  const client = opts.client ?? new GhCliIssueClient();
  const existing = client.findOpenIssue?.({ repo, title });
  if (existing) return { status: "existing", repo, url: existing.url, title, labels };

  const created = client.createIssue({ repo, title, body, labels });
  return { status: "created", repo, url: created.url, title, labels };
}

function parseCliArgs(argv: string[]) {
  const args = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    if (arg === "--dry-run" || arg === "--json") {
      args.set(arg, true);
      continue;
    }
    args.set(arg, argv[i + 1] ?? "");
    i += 1;
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseCliArgs(process.argv.slice(2));
  const raw = args.get("--input-json");
  if (typeof raw !== "string" || !raw.trim()) {
    console.error("Usage: issue-reporter.ts --input-json '{...}' [--dry-run] [--json]");
    process.exit(2);
  }

  const input = JSON.parse(raw) as OperationalIssueInput;
  const result = reportOperationalIssue(input, { dryRun: args.has("--dry-run") });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
