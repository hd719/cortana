#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { query } from "../lib/db.js";
import { resolveRepoPath } from "../lib/paths.js";

type Json = Record<string, any>;

type Gap = {
  name: string;
  evidence_count: number;
  examples: string[];
  intent_terms: string[];
};

type Proposal = {
  gap: string;
  local_matches: string[];
  clawdhub_matches: string[];
  integration_pattern: string;
  effort: number;
  impact: number;
  risk: number;
  expected_payoff: number;
  confidence: number;
  recommendation: string;
};

const DB_NAME = "cortana";
const SOURCE = "capability_marketplace";
const SKILLS_DIR = path.join(resolveRepoPath(), "skills");

function sqlEscape(text: string): string {
  return (text || "").replace(/'/g, "''");
}

function runPsql(sql: string): string {
  return query(sql).trim();
}

function fetchJson(sql: string): Array<Record<string, any>> {
  const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (${sql}) t;`;
  const raw = runPsql(wrapped);
  return raw ? (JSON.parse(raw) as Array<Record<string, any>>) : [];
}

function logEvent(message: string, severity: string, metadata: Record<string, any>, dryRun: boolean): void {
  if (dryRun) return;
  runPsql(
    "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES " +
      `('capability_marketplace','${SOURCE}','${sqlEscape(severity)}','${sqlEscape(
        message
      )}','${sqlEscape(JSON.stringify(metadata))}'::jsonb);`
  );
}

async function httpGet(url: string, timeoutSeconds = 10): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "cortana-capability-marketplace/1.0" },
      signal: controller.signal,
    });
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function tokenize(text: string): string[] {
  const toks = (text || "")
    .toLowerCase()
    .match(/[a-zA-Z][a-zA-Z0-9_-]{2,}/g);
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "task",
    "error",
    "failed",
    "manual",
    "need",
    "should",
  ]);
  return (toks ?? []).filter((t) => !stop.has(t));
}

function mineGaps(windowDays: number): Gap[] {
  const window = Math.max(7, windowDays);
  const rows = fetchJson(
    "SELECT COALESCE(source,'task') AS source, COALESCE(title,'') AS title, COALESCE(description,'') AS description, COALESCE(outcome,'') AS outcome " +
      "FROM cortana_tasks " +
      `WHERE created_at > NOW() - INTERVAL '${window} days' ` +
      "AND status IN ('ready','in_progress','cancelled') " +
      "UNION ALL " +
      "SELECT 'feedback' AS source, COALESCE(context,'') AS title, COALESCE(lesson,'') AS description, '' AS outcome " +
      "FROM cortana_feedback " +
      `WHERE timestamp > NOW() - INTERVAL '${window} days' ` +
      "UNION ALL " +
      "SELECT COALESCE(source,'event') AS source, COALESCE(message,'') AS title, COALESCE(metadata::text,'') AS description, '' AS outcome " +
      "FROM cortana_events " +
      `WHERE timestamp > NOW() - INTERVAL '${window} days' ` +
      "AND severity IN ('warning','error')"
  );

  const bucket: Record<string, { count: number; examples: string[]; terms: Record<string, number> }> = {};
  for (const r of rows) {
    const text = `${r.title ?? ""} ${r.description ?? ""} ${r.outcome ?? ""}`;
    const terms = tokenize(text);
    if (!terms.length) continue;

    let label = "workflow_automation";
    if (terms.some((k) => ["calendar", "gmail", "email", "inbox"].includes(k))) {
      label = "comms_calendar";
    } else if (terms.some((k) => ["security", "incident", "alert", "auth"].includes(k))) {
      label = "security_ops";
    } else if (terms.some((k) => ["market", "mortgage", "rate", "portfolio"].includes(k))) {
      label = "market_intel";
    } else if (terms.some((k) => ["memory", "context", "knowledge", "search"].includes(k))) {
      label = "knowledge_retrieval";
    }

    const entry = bucket[label] ?? { count: 0, examples: [], terms: {} };
    entry.count += 1;
    if (entry.examples.length < 5) entry.examples.push(text.slice(0, 200));
    for (const t of terms.slice(0, 18)) {
      entry.terms[t] = (entry.terms[t] ?? 0) + 1;
    }
    bucket[label] = entry;
  }

  const gaps: Gap[] = [];
  for (const [name, data] of Object.entries(bucket)) {
    const topTerms = Object.entries(data.terms)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k]) => k);
    gaps.push({
      name,
      evidence_count: Number(data.count),
      examples: data.examples,
      intent_terms: topTerms,
    });
  }
  return gaps.sort((a, b) => b.evidence_count - a.evidence_count);
}

function localSkills(): string[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
}

function mapLocalSkills(gap: Gap, skills: string[]): string[] {
  const curated: Record<string, string[]> = {
    workflow_automation: ["clawddocs", "clawdhub", "process-watch", "telegram-usage"],
    security_ops: ["healthcheck", "process-watch"],
    comms_calendar: ["gog", "caldav-calendar"],
    market_intel: ["news-summary", "weather", "bird"],
    knowledge_retrieval: ["clawddocs", "skill-creator"],
  };
  const seed = (curated[gap.name] ?? []).filter((s) => skills.includes(s));

  const terms = new Set([...gap.intent_terms, ...gap.name.split("_")]);
  const fuzzy: string[] = [];
  for (const s of skills) {
    const sTokens = new Set(tokenize(s.replace(/-/g, " ")));
    for (const t of terms) {
      if (sTokens.has(t)) {
        fuzzy.push(s);
        break;
      }
    }
  }

  const merged: string[] = [];
  for (const name of [...seed, ...fuzzy]) {
    if (!merged.includes(name)) merged.push(name);
  }
  return merged.slice(0, 6);
}

async function clawdhubSearch(term: string): Promise<string[]> {
  const candidates: string[] = [];
  const urls = [
    `https://clawdhub.com/search?q=${encodeURIComponent(term)}`,
    `https://clawdhub.com/skills?q=${encodeURIComponent(term)}`,
    `https://clawdhub.com/api/skills?query=${encodeURIComponent(term)}`,
  ];

  for (const url of urls) {
    try {
      const body = await httpGet(url, 8);
      const trimmed = body.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const js = JSON.parse(trimmed);
          const rows = Array.isArray(js) ? js : js.skills ?? js.results ?? [];
          for (const r of rows.slice(0, 10)) {
            if (r && typeof r === "object") {
              const nm = String(r.name ?? r.slug ?? "").trim();
              if (nm) candidates.push(nm);
            }
          }
        } catch {
          // ignore json errors
        }
      }

      const matches = body.matchAll(/\/skills\/([a-zA-Z0-9_-]+)/g);
      for (const m of matches) {
        candidates.push(m[1]);
      }
    } catch {
      continue;
    }
  }

  return Array.from(new Set(candidates)).slice(0, 8);
}

function pickPattern(gap: Gap): string {
  if (gap.name === "comms_calendar") return "heartbeat-driven triage + task auto-sync";
  if (gap.name === "security_ops") return "event ingestion + severity routing + playbook execution";
  if (gap.name === "market_intel") return "daily signal collector + advisor formatter + task trigger";
  if (gap.name === "knowledge_retrieval") return "memory index refresh + retrieval scoring + response templates";
  return "detect -> score -> propose -> task";
}

function rankProposal(gap: Gap, local: string[], hub: string[]): Proposal {
  const impact = Math.min(0.97, 0.45 + gap.evidence_count * 0.06);
  const effort = Math.max(0.15, 0.7 - 0.08 * local.length - 0.03 * hub.length);
  const risk = 0.25 + (local.length === 0 ? 0.08 : 0.0) + (hub.length > 0 ? 0.05 : 0.0);
  const expectedPayoff = Math.round(Math.max(0, impact - effort - risk * 0.35) * 1000) / 1000;
  const confidence =
    Math.round(Math.min(0.96, 0.5 + Math.min(gap.evidence_count, 8) * 0.04 + local.length * 0.03) * 1000) /
    1000;
  const rec =
    `Address '${gap.name}' by reusing ${local.slice(0, 3).join(", ") || "existing tools"}` +
    ` and adding ${hub.slice(0, 2).join(", ") || "targeted custom glue"} if needed.`;
  return {
    gap: gap.name,
    local_matches: local,
    clawdhub_matches: hub,
    integration_pattern: pickPattern(gap),
    effort: Math.round(effort * 1000) / 1000,
    impact: Math.round(impact * 1000) / 1000,
    risk: Math.round(Math.min(0.95, risk) * 1000) / 1000,
    expected_payoff: expectedPayoff,
    confidence,
    recommendation: rec,
  };
}

function maybeCreateTask(prop: Proposal, threshold: number, dryRun: boolean): number | null {
  if (dryRun || prop.confidence < threshold || prop.expected_payoff < 0.22) return null;
  const title = `Capability upgrade: ${prop.gap}`;
  const desc =
    `Recommendation: ${prop.recommendation}\n` +
    `Pattern: ${prop.integration_pattern}\n` +
    `Impact/Effort/Risk/Payoff: ${prop.impact}/${prop.effort}/${prop.risk}/${prop.expected_payoff}`;
  const meta = JSON.stringify(prop);
  const raw = runPsql(
    "INSERT INTO cortana_tasks (source, title, description, priority, status, auto_executable, execution_plan, metadata) VALUES " +
      `('capability_marketplace','${sqlEscape(title)}','${sqlEscape(desc)}',2,'ready',TRUE,` +
      "'1) Validate fit 2) Prototype integration 3) Measure impact and harden'," +
      `'${sqlEscape(meta)}'::jsonb) RETURNING id;`
  );
  return raw ? Number(raw) : null;
}

type Args = {
  windowDays: number;
  maxProposals: number;
  taskThreshold: number;
  createTasks: boolean;
  dryRun: boolean;
  json: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    windowDays: 30,
    maxProposals: 5,
    taskThreshold: 0.84,
    createTasks: false,
    dryRun: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--window-days":
        args.windowDays = Number(argv[i + 1]);
        i += 1;
        break;
      case "--max-proposals":
        args.maxProposals = Number(argv[i + 1]);
        i += 1;
        break;
      case "--task-threshold":
        args.taskThreshold = Number(argv[i + 1]);
        i += 1;
        break;
      case "--create-tasks":
        args.createTasks = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--json":
        args.json = true;
        break;
      default:
        break;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const errors: string[] = [];

  let gaps: Gap[] = [];
  try {
    gaps = mineGaps(args.windowDays);
  } catch (e) {
    errors.push(`gap-mining: ${e instanceof Error ? e.message : String(e)}`);
  }

  const skills = localSkills();
  let proposals: Proposal[] = [];

  for (const gap of gaps) {
    const local = mapLocalSkills(gap, skills);
    const hubMatches: string[] = [];
    for (const term of gap.intent_terms.slice(0, 3)) {
      try {
        hubMatches.push(...(await clawdhubSearch(term)));
      } catch (e) {
        errors.push(`clawdhub ${term}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const dedup = Array.from(new Set(hubMatches)).slice(0, 8);
    proposals.push(rankProposal(gap, local, dedup));
  }

  proposals = proposals
    .sort((a, b) => {
      if (b.expected_payoff !== a.expected_payoff) return b.expected_payoff - a.expected_payoff;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.effort - b.effort;
    })
    .slice(0, Math.max(1, args.maxProposals));

  const createdTasks: number[] = [];
  if (args.createTasks) {
    for (const p of proposals) {
      try {
        const tid = maybeCreateTask(p, args.taskThreshold, args.dryRun);
        if (tid) createdTasks.push(tid);
      } catch (e) {
        errors.push(`task-create ${p.gap}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  logEvent(
    `Capability marketplace generated ${proposals.length} proposals`,
    errors.length ? "warning" : "info",
    { proposals: proposals.length, tasks_created: createdTasks, errors: errors.slice(0, 8) },
    args.dryRun
  );

  const payload = {
    source: SOURCE,
    generated_at: new Date().toISOString(),
    gaps_identified: gaps,
    proposals,
    tasks_created: createdTasks,
    errors,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log("Capability Marketplace Proposals");
    proposals.forEach((p, idx) => {
      console.log(`\n${idx + 1}. ${p.gap}`);
      console.log(`   recommendation: ${p.recommendation}`);
      console.log(`   local skills:   ${p.local_matches.join(", ") || "-"}`);
      console.log(`   clawdhub:       ${p.clawdhub_matches.join(", ") || "-"}`);
      console.log(
        `   effort/impact/risk/payoff/conf: ${p.effort}/${p.impact}/${p.risk}/${p.expected_payoff}/${p.confidence}`
      );
    });
    if (createdTasks.length) console.log(`\nTasks created: ${JSON.stringify(createdTasks)}`);
    if (errors.length) {
      console.log("\nErrors:");
      errors.slice(0, 12).forEach((e) => console.log(`- ${e}`));
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
