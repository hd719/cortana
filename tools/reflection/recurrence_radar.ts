#!/usr/bin/env npx tsx

import { query } from "../lib/db.js";

import { createHash } from "crypto";

const SOURCE = "recurrence_radar";

type FeedbackRow = {
  id: number;
  timestamp: Date;
  feedback_type: string;
  context: string;
  lesson: string;
};

type Cluster = {
  key: string;
  canonical_lesson: string;
  items: FeedbackRow[];
};

type MatchBlock = { i: number; j: number; size: number };

function sqlEscape(text: string): string {
  return text.replace(/'/g, "''");
}

function runPsql(sql: string): string {
  return query(sql).trim();
}

function fetchJson(sql: string): Array<Record<string, any>> {
  const wrapped = `SELECT COALESCE(json_agg(t), '[]'::json)::text FROM (${sql}) t;`;
  const raw = runPsql(wrapped);
  return raw ? (JSON.parse(raw) as Array<Record<string, any>>) : [];
}

function parseTs(value: string): Date {
  return new Date(value.replace("Z", "+00:00"));
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildB2j(b: string[], autojunk = true): Map<string, number[]> {
  const b2j = new Map<string, number[]>();
  for (let i = 0; i < b.length; i += 1) {
    const elt = b[i];
    const arr = b2j.get(elt);
    if (arr) arr.push(i);
    else b2j.set(elt, [i]);
  }
  if (autojunk && b.length >= 200) {
    const ntest = Math.floor(b.length / 100) + 1;
    for (const [elt, idxs] of b2j.entries()) {
      if (idxs.length > ntest) b2j.delete(elt);
    }
  }
  return b2j;
}

function findLongestMatch(
  a: string[],
  b: string[],
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
  b2j: Map<string, number[]>
): MatchBlock {
  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();

  for (let i = alo; i < ahi; i += 1) {
    const newj2len = new Map<number, number>();
    const indices = b2j.get(a[i]) ?? [];
    for (const j of indices) {
      if (j < blo) continue;
      if (j >= bhi) break;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = newj2len;
  }

  return { i: besti, j: bestj, size: bestsize };
}

function getMatchingBlocks(a: string[], b: string[]): MatchBlock[] {
  const la = a.length;
  const lb = b.length;
  const b2j = buildB2j(b);
  const queue: Array<[number, number, number, number]> = [[0, la, 0, lb]];
  const matching: MatchBlock[] = [];

  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop() as [number, number, number, number];
    const match = findLongestMatch(a, b, alo, ahi, blo, bhi, b2j);
    if (match.size) {
      if (alo < match.i && blo < match.j) {
        queue.push([alo, match.i, blo, match.j]);
      }
      if (match.i + match.size < ahi && match.j + match.size < bhi) {
        queue.push([match.i + match.size, ahi, match.j + match.size, bhi]);
      }
      matching.push(match);
    }
  }

  matching.sort((x, y) => (x.i - y.i) || (x.j - y.j));
  const nonAdjacent: MatchBlock[] = [];
  let i1 = 0;
  let j1 = 0;
  let k1 = 0;
  for (const m of matching) {
    if (m.i === i1 + k1 && m.j === j1 + k1) {
      k1 += m.size;
    } else {
      if (k1) nonAdjacent.push({ i: i1, j: j1, size: k1 });
      i1 = m.i;
      j1 = m.j;
      k1 = m.size;
    }
  }
  if (k1) nonAdjacent.push({ i: i1, j: j1, size: k1 });
  nonAdjacent.push({ i: la, j: lb, size: 0 });
  return nonAdjacent;
}

function sequenceMatcherRatio(a: string, b: string): number {
  if (!a && !b) return 1.0;
  if (!a || !b) return 0.0;
  const aa = a.split("");
  const bb = b.split("");
  const blocks = getMatchingBlocks(aa, bb);
  const matches = blocks.reduce((sum, blk) => sum + blk.size, 0);
  return (2.0 * matches) / (aa.length + bb.length);
}

function similarity(a: string, b: string): number {
  return sequenceMatcherRatio(normalize(a), normalize(b));
}

function startRun(triggerSource: string, windowDays: number, dryRun: boolean): number | null {
  if (dryRun) return null;
  const rid = runPsql(
    "INSERT INTO cortana_reflection_runs (trigger_source, mode, window_days, status) " +
      `VALUES ('${sqlEscape(triggerSource)}', 'recurrence_radar', ${windowDays}, 'running') RETURNING id;`
  );
  return Number(rid);
}

function logEvent(eventType: string, severity: string, message: string, metadata: Record<string, any>, dryRun: boolean): void {
  if (dryRun) return;
  const meta = sqlEscape(JSON.stringify(metadata));
  runPsql(
    "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES " +
      `('${sqlEscape(eventType)}','${SOURCE}','${sqlEscape(severity)}','${sqlEscape(message)}','${meta}'::jsonb);`
  );
}

function fetchFeedback(windowDays: number): FeedbackRow[] {
  const rows = fetchJson(
    "SELECT id, timestamp, feedback_type, COALESCE(context,'') AS context, COALESCE(lesson,'') AS lesson " +
      "FROM cortana_feedback " +
      "WHERE COALESCE(lesson, '') <> '' " +
      "  AND feedback_type IN ('correction', 'behavior', 'tone', 'preference', 'fact') " +
      `  AND timestamp > NOW() - INTERVAL '${Math.max(1, windowDays)} days' ` +
      "ORDER BY timestamp ASC"
  );
  return rows.map((r) => ({
    id: Number(r.id),
    timestamp: parseTs(String(r.timestamp)),
    feedback_type: String(r.feedback_type),
    context: String(r.context ?? ""),
    lesson: String(r.lesson ?? ""),
  }));
}

function clusterFeedback(rows: FeedbackRow[], threshold: number): Cluster[] {
  const clusters: Cluster[] = [];
  for (const row of rows) {
    let bestCluster: Cluster | null = null;
    let bestScore = 0.0;
    for (const cluster of clusters) {
      const score = similarity(row.lesson, cluster.canonical_lesson);
      if (score > bestScore) {
        bestScore = score;
        bestCluster = cluster;
      }
    }
    if (bestCluster && bestScore >= threshold) {
      bestCluster.items.push(row);
      bestCluster.canonical_lesson = [bestCluster.canonical_lesson, row.lesson].sort(
        (a, b) => Math.abs(a.length - 100) - Math.abs(b.length - 100)
      )[0];
    } else {
      const key = createHash("sha1").update(normalize(row.lesson), "utf8").digest("hex").slice(0, 12);
      clusters.push({ key, canonical_lesson: row.lesson, items: [row] });
    }
  }
  return clusters;
}

function timeToRecurrenceHours(cluster: Cluster): number | null {
  if (cluster.items.length < 2) return null;
  const sorted = [...cluster.items].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const delta = sorted[1].timestamp.getTime() - sorted[0].timestamp.getTime();
  return Math.round((delta / 3600000) * 100) / 100;
}

function repeatsPer7d(cluster: Cluster): number {
  if (cluster.items.length < 2) return 0.0;
  const sorted = [...cluster.items].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const totalDays = Math.max(1 / 24, (sorted[sorted.length - 1].timestamp.getTime() - sorted[0].timestamp.getTime()) / 86400000);
  const repeatCount = cluster.items.length - 1;
  return Math.round((repeatCount / (totalDays / 7)) * 100) / 100;
}

function ensureRemediationTask(cluster: Cluster, dryRun: boolean): number | null {
  const clusterHash = createHash("sha1").update(normalize(cluster.canonical_lesson), "utf8").digest("hex");
  const existing = runPsql(
    "SELECT COALESCE((SELECT id FROM cortana_tasks " +
      "WHERE status IN ('ready','in_progress') " +
      `  AND metadata->>'recurrence_cluster_hash' = '${clusterHash}' ` +
      "ORDER BY id DESC LIMIT 1), 0);"
  );
  const existingId = Number(existing || 0);
  if (existingId) return existingId;
  if (dryRun) return null;

  const title = `Remediate recurring correction cluster: ${cluster.canonical_lesson.slice(0, 72)}`;
  const desc =
    "Recurrence radar detected 5+ repeats for a correction pattern. " +
    "Create and apply durable fix in AGENTS/SOUL/MEMORY/scripts as appropriate.";
  const metadata = {
    created_by: SOURCE,
    recurrence_cluster_hash: clusterHash,
    cluster_size: cluster.items.length,
    sample_feedback_ids: cluster.items.slice(0, 10).map((item) => item.id),
    canonical_lesson: cluster.canonical_lesson,
  };
  const newId = runPsql(
    "INSERT INTO cortana_tasks (source, title, description, priority, auto_executable, status, execution_plan, metadata) " +
      `VALUES ('reflection', '${sqlEscape(title)}', '${sqlEscape(desc)}', 1, true, 'ready', ` +
      "'1) Inspect recurrence evidence 2) Strengthen rule language 3) Verify no further repeats', " +
      `'${sqlEscape(JSON.stringify(metadata))}'::jsonb) RETURNING id;`
  );
  return Number(newId);
}

function escalationForSize(size: number): string | null {
  if (size >= 5) return "create_remediation_task";
  if (size >= 3) return "suggest_rule_strengthening";
  if (size >= 2) return "warning";
  return null;
}

function run(windowDays: number, threshold: number, triggerSource: string, dryRun: boolean): Record<string, any> {
  const runId = startRun(triggerSource, windowDays, dryRun);
  try {
    const rows = fetchFeedback(windowDays);
    const clusters = clusterFeedback(rows, threshold);
    const recurring = clusters.filter((c) => c.items.length >= 2);

    const clusterReports: Record<string, any>[] = [];
    const ttrValues: number[] = [];

    for (const cluster of recurring) {
      const sortedItems = [...cluster.items].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      const ttrHours = timeToRecurrenceHours(cluster);
      if (ttrHours !== null) ttrValues.push(ttrHours);
      const r7 = repeatsPer7d(cluster);
      const escalation = escalationForSize(cluster.items.length);
      let remediationTaskId: number | null = null;

      if (escalation === "warning") {
        logEvent(
          "recurrence_warning",
          "warning",
          `Recurring correction cluster detected (size=2): ${cluster.canonical_lesson.slice(0, 160)}`,
          {
            run_id: runId,
            cluster_key: cluster.key,
            cluster_size: cluster.items.length,
            feedback_ids: sortedItems.map((x) => x.id),
            time_to_recurrence_hours: ttrHours,
            repeats_per_7d: r7,
          },
          dryRun
        );
      } else if (escalation === "suggest_rule_strengthening") {
        const suggestion =
          "Strengthen rule language from soft guidance to explicit prohibition + required action.";
        logEvent(
          "recurrence_escalation",
          "warning",
          `Cluster reached size ${cluster.items.length}; rule-strengthening suggested`,
          {
            run_id: runId,
            cluster_key: cluster.key,
            cluster_size: cluster.items.length,
            suggestion,
            canonical_lesson: cluster.canonical_lesson,
          },
          dryRun
        );
      } else if (escalation === "create_remediation_task") {
        remediationTaskId = ensureRemediationTask(cluster, dryRun);
        logEvent(
          "recurrence_escalation",
          "error",
          `Cluster reached size ${cluster.items.length}; remediation task queued`,
          {
            run_id: runId,
            cluster_key: cluster.key,
            cluster_size: cluster.items.length,
            task_id: remediationTaskId,
          },
          dryRun
        );
      }

      clusterReports.push({
        cluster_key: cluster.key,
        size: cluster.items.length,
        canonical_lesson: cluster.canonical_lesson,
        feedback_ids: sortedItems.map((x) => x.id),
        first_seen: sortedItems[0].timestamp.toISOString(),
        last_seen: sortedItems[sortedItems.length - 1].timestamp.toISOString(),
        time_to_recurrence_hours: ttrHours,
        repeats_per_7d: r7,
        escalation,
        remediation_task_id: remediationTaskId,
      });
    }

    const avgTtr = ttrValues.length
      ? Math.round((ttrValues.reduce((a, b) => a + b, 0) / ttrValues.length) * 100) / 100
      : null;
    const report = {
      run_id: runId,
      status: "completed",
      window_days: windowDays,
      similarity_threshold: threshold,
      feedback_rows: rows.length,
      clusters_total: clusters.length,
      recurring_clusters: recurring.length,
      sla_metrics: {
        avg_time_to_recurrence_hours: avgTtr,
        cluster_time_to_recurrence_hours: Object.fromEntries(
          clusterReports.map((r) => [r.cluster_key, r.time_to_recurrence_hours])
        ),
        cluster_repeats_per_7d: Object.fromEntries(
          clusterReports.map((r) => [r.cluster_key, r.repeats_per_7d])
        ),
      },
      clusters: clusterReports,
      generated_at: new Date().toISOString(),
      dry_run: dryRun,
    };

    if (!dryRun && runId !== null) {
      const summary = `Radar processed ${rows.length} rows, found ${recurring.length} recurring clusters (threshold=${threshold.toFixed(
        2
      )}).`;
      runPsql(
        "UPDATE cortana_reflection_runs SET completed_at=NOW(), status='completed', " +
          `feedback_rows=${rows.length}, rules_extracted=${recurring.length}, summary='${sqlEscape(summary)}', ` +
          `metadata='${sqlEscape(JSON.stringify(report))}'::jsonb WHERE id=${runId};`
      );
    }

    return report;
  } catch (exc) {
    if (!dryRun && runId !== null) {
      runPsql(
        "UPDATE cortana_reflection_runs SET completed_at=NOW(), status='failed', " +
          `error='${sqlEscape(String(exc))}' WHERE id=${runId};`
      );
    }
    throw exc;
  }
}

function printHelp(): void {
  const text = `usage: recurrence_radar.ts [-h] [--window-days WINDOW_DAYS] [--similarity-threshold SIMILARITY_THRESHOLD] [--trigger-source {manual,heartbeat,cron,post_task}] [--dry-run]\n\nRecurrence radar v2 for cortana_feedback corrections\n\noptions:\n  -h, --help            show this help message and exit\n  --window-days WINDOW_DAYS  How far back to analyze corrections\n  --similarity-threshold SIMILARITY_THRESHOLD  difflib similarity threshold (0-1)\n  --trigger-source {manual,heartbeat,cron,post_task}\n  --dry-run             No DB writes (events/tasks/run updates)`;
  console.log(text);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    return;
  }

  let windowDays = 30;
  let similarityThreshold = 0.72;
  let triggerSource = "manual";
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--window-days" && next) {
      windowDays = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--similarity-threshold" && next) {
      similarityThreshold = Number.parseFloat(next);
      i += 1;
    } else if (arg === "--trigger-source" && next) {
      triggerSource = next;
      i += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("-")) {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(2);
    }
  }

  const report = run(
    Math.max(1, windowDays),
    Math.min(0.99, Math.max(0.1, similarityThreshold)),
    triggerSource,
    dryRun
  );
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
