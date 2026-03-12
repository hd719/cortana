#!/usr/bin/env npx tsx

import fs from "node:fs";
import path from "node:path";
import { resolveRepoPath } from "../lib/paths.js";

type RequiredDoc = {
  path: string;
  phrases: string[];
};

type StablePreferenceRule = {
  id: string;
  summary: string;
  updateFiles: string[];
  requiredDocs?: RequiredDoc[];
};

type RoutingRule = {
  id: string;
  scopeLabel: string;
  expectedOwner: string;
  jobKeywords: string[];
  requireExplicitOwner: boolean;
  requireQuietHealthy: boolean;
};

type Config = {
  version: number;
  stablePreferenceRules: StablePreferenceRule[];
  routingRules: RoutingRule[];
};

type CronJob = {
  id?: string;
  name?: string;
  agentId?: string;
  delivery?: {
    accountId?: string;
    mode?: string;
  };
  payload?: {
    message?: string;
  };
};

type Finding = {
  type: "doc_contract" | "delivery_owner" | "prompt_owner" | "quiet_path";
  id: string;
  scope: string;
  summary: string;
  filesToUpdate: string[];
  jobId?: string;
  jobName?: string;
  expectedOwner?: string;
  actualOwner?: string | null;
  missingPhrases?: string[];
};

type Args = {
  json: boolean;
  repoRoot: string;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let json = false;
  let repoRoot = resolveRepoPath();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--repo-root" && argv[i + 1]) repoRoot = path.resolve(argv[++i]);
  }

  return { json, repoRoot };
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, "utf8");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readText(filePath)) as T;
}

function normalize(text: string): string {
  return text.toLowerCase();
}

function includesAllPhrases(content: string, phrases: string[]): string[] {
  const haystack = normalize(content);
  return phrases.filter((phrase) => !haystack.includes(normalize(phrase)));
}

function extractPromptOwners(message: string): string[] {
  const owners = new Set<string>();

  for (const match of message.matchAll(/accountId\s*[:=]\s*([A-Za-z0-9_-]+)/g)) {
    owners.add(match[1].toLowerCase());
  }

  for (const match of message.matchAll(/\bP[0-3]\s+(monitor|researcher|huragok|oracle|default)\b/gi)) {
    owners.add(match[1].toLowerCase());
  }

  for (const match of message.matchAll(/\bowner\s*[=: ]\s*(monitor|researcher|huragok|oracle|default)\b/gi)) {
    owners.add(match[1].toLowerCase());
  }

  return [...owners];
}

function jobMatches(job: CronJob, rule: RoutingRule): boolean {
  const text = `${job.name ?? ""}\n${job.payload?.message ?? ""}`;
  const haystack = normalize(text);
  return rule.jobKeywords.some((keyword) => haystack.includes(normalize(keyword)));
}

function stableRuleForScope(config: Config, scope: string): StablePreferenceRule {
  return (
    config.stablePreferenceRules.find((rule) => normalize(rule.summary).includes(normalize(scope))) ??
    config.stablePreferenceRules[0]
  );
}

function checkDocs(repoRoot: string, config: Config): Finding[] {
  const findings: Finding[] = [];

  for (const rule of config.stablePreferenceRules) {
    for (const doc of rule.requiredDocs ?? []) {
      const filePath = path.join(repoRoot, doc.path);
      const content = readText(filePath);
      const missingPhrases = includesAllPhrases(content, doc.phrases);
      if (!missingPhrases.length) continue;

      findings.push({
        type: "doc_contract",
        id: rule.id,
        scope: rule.summary,
        summary: `${doc.path} is missing stable routing phrases for ${rule.summary}`,
        filesToUpdate: rule.updateFiles,
        missingPhrases,
      });
    }
  }

  return findings;
}

function checkJobs(repoRoot: string, config: Config): Finding[] {
  const cronPath = path.join(repoRoot, "config", "cron", "jobs.json");
  const cron = readJson<{ jobs?: CronJob[] }>(cronPath);
  const jobs = Array.isArray(cron.jobs) ? cron.jobs : [];
  const findings: Finding[] = [];

  for (const job of jobs) {
    for (const rule of config.routingRules) {
      if (!jobMatches(job, rule)) continue;

      const prompt = job.payload?.message ?? "";
      const promptOwners = extractPromptOwners(prompt);
      const deliveryOwner = job.delivery?.accountId?.toLowerCase() ?? null;
      const stableRule = stableRuleForScope(config, rule.scopeLabel);

      if (deliveryOwner && deliveryOwner !== rule.expectedOwner) {
        findings.push({
          type: "delivery_owner",
          id: rule.id,
          scope: rule.scopeLabel,
          summary: `${job.name ?? job.id ?? "cron job"} routes delivery to ${deliveryOwner}, expected ${rule.expectedOwner}`,
          filesToUpdate: stableRule.updateFiles,
          jobId: job.id,
          jobName: job.name,
          expectedOwner: rule.expectedOwner,
          actualOwner: deliveryOwner,
        });
      }

      if (rule.requireExplicitOwner) {
        if (!promptOwners.length) {
          findings.push({
            type: "prompt_owner",
            id: rule.id,
            scope: rule.scopeLabel,
            summary: `${job.name ?? job.id ?? "cron job"} is missing explicit prompt ownership for ${rule.scopeLabel}`,
            filesToUpdate: stableRule.updateFiles,
            jobId: job.id,
            jobName: job.name,
            expectedOwner: rule.expectedOwner,
            actualOwner: null,
          });
        } else {
          const mismatched = promptOwners.filter((owner) => owner !== rule.expectedOwner);
          if (mismatched.length) {
            findings.push({
              type: "prompt_owner",
              id: rule.id,
              scope: rule.scopeLabel,
              summary: `${job.name ?? job.id ?? "cron job"} names ${mismatched.join(", ")} in the prompt, expected ${rule.expectedOwner}`,
              filesToUpdate: stableRule.updateFiles,
              jobId: job.id,
              jobName: job.name,
              expectedOwner: rule.expectedOwner,
              actualOwner: mismatched.join(", "),
            });
          }
        }
      }

      if (rule.requireQuietHealthy && !prompt.includes("NO_REPLY")) {
        findings.push({
          type: "quiet_path",
          id: rule.id,
          scope: rule.scopeLabel,
          summary: `${job.name ?? job.id ?? "cron job"} is missing an explicit NO_REPLY healthy path`,
          filesToUpdate: stableRule.updateFiles,
          jobId: job.id,
          jobName: job.name,
          expectedOwner: rule.expectedOwner,
        });
      }
    }
  }

  return findings;
}

function main(): void {
  const args = parseArgs();
  const configPath = path.join(args.repoRoot, "config", "ops-hygiene-rules.json");
  const config = readJson<Config>(configPath);

  const findings = [...checkDocs(args.repoRoot, config), ...checkJobs(args.repoRoot, config)];
  const deduped = findings.filter(
    (finding, index, all) =>
      all.findIndex(
        (other) =>
          other.type === finding.type &&
          other.scope === finding.scope &&
          other.summary === finding.summary &&
          other.jobId === finding.jobId,
      ) === index,
  );

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          status: deduped.length ? "needs_action" : "healthy",
          findings: deduped,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!deduped.length) {
    console.log("NO_REPLY");
    return;
  }

  const lines = ["🧭 Ops Routing Drift"];
  for (const finding of deduped) {
    lines.push(`- ${finding.summary}`);
  }

  const filesToUpdate = [...new Set(deduped.flatMap((finding) => finding.filesToUpdate))];
  lines.push(`- Update together: ${filesToUpdate.join(", ")}`);
  console.log(lines.join("\n"));
}

main();
