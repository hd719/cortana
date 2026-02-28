#!/usr/bin/env npx tsx

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { createInterface } from "readline";

const WORKSPACE = "/Users/hd/openclaw";
const MEMORY_DIR = path.join(WORKSPACE, "memory");
const PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql";
const DB = "cortana";

class PsqlSession {
  static END_MARKER = "__OPENCLAW_SQL_DONE__";
  private proc;
  private lineQueue: string[] = [];
  private lineResolvers: Array<(line: string) => void> = [];
  private closed = false;
  private exitCode: number | null = null;

  constructor(dbName: string) {
    this.proc = spawn(PSQL, [dbName, "-q", "-v", "ON_ERROR_STOP=1", "-At"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const handleLine = (line: string) => {
      if (this.lineResolvers.length > 0) {
        const resolve = this.lineResolvers.shift();
        resolve?.(line);
      } else {
        this.lineQueue.push(line);
      }
    };

    const stdoutRl = createInterface({ input: this.proc.stdout });
    stdoutRl.on("line", handleLine);

    const stderrRl = createInterface({ input: this.proc.stderr });
    stderrRl.on("line", handleLine);

    this.proc.on("close", (code) => {
      this.closed = true;
      this.exitCode = code ?? null;
    });
  }

  private async readLine(): Promise<string> {
    if (this.lineQueue.length > 0) {
      return this.lineQueue.shift() as string;
    }
    return new Promise((resolve) => {
      this.lineResolvers.push(resolve);
    });
  }

  private async run(sql: string): Promise<string> {
    if (!this.proc.stdin || this.closed) {
      throw new Error("psql session unavailable");
    }

    const payload = `${sql.replace(/;\s*$/, "")};\n\\echo ${PsqlSession.END_MARKER}\n`;
    this.proc.stdin.write(payload);

    const lines: string[] = [];
    while (true) {
      const line = await this.readLine();
      if (line === PsqlSession.END_MARKER) break;
      if (line === "" && this.closed) {
        const tail = lines.join("\n").trim();
        throw new Error(`psql session terminated (code=${this.exitCode}): ${tail}`);
      }
      lines.push(line);
    }

    const out = lines.join("\n").trim();
    if (out.startsWith("ERROR:") || out.includes("\nERROR:")) {
      throw new Error(out);
    }
    return out;
  }

  async execute(sql: string): Promise<void> {
    await this.run(sql);
  }

  async queryValue(sql: string): Promise<string> {
    const out = await this.run(sql);
    if (!out) return "";
    return out.split(/\r?\n/)[0] ?? "";
  }

  async queryRows(sql: string): Promise<string[]> {
    const out = await this.run(sql);
    return out ? out.split(/\r?\n/) : [];
  }

  close(): void {
    if (!this.closed) {
      this.proc.terminate();
    }
  }
}

function q(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function fp(...parts: Array<string | undefined | null>): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(p ?? "");
    h.update("|");
  }
  return h.digest("hex").slice(0, 32);
}

async function qualityGate(text: string, enabled: boolean, dry: boolean): Promise<Record<string, unknown>> {
  if (!enabled) return { verdict: "promote" };
  const gate = path.join(WORKSPACE, "tools", "memory", "memory_quality_gate.py");
  if (!fs.existsSync(gate)) {
    return { verdict: "promote", reason: "gate_missing" };
  }
  try {
    const proc = spawn("python3", [gate, "--text", text, "--dry-run"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    for await (const chunk of proc.stdout) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const out = Buffer.concat(chunks).toString("utf8");
    const status = await new Promise<number>((resolve) => proc.on("close", (code) => resolve(code ?? 1)));
    if (status !== 0) return { verdict: "hold", reason: "gate_error" };
    const data = JSON.parse(out.trim() || "{}");
    return data && typeof data === "object" ? data : { verdict: "hold" };
  } catch {
    return { verdict: "hold", reason: "gate_exception" };
  }
}

async function finalizeStaleRuns(db: PsqlSession, dry: boolean): Promise<void> {
  if (dry) return;
  const reason = "Stale run auto-finalized (exceeded 1hr TTL)";
  await db.execute(
    `
UPDATE cortana_memory_ingest_runs
SET status = 'failed',
    finished_at = NOW(),
    errors = jsonb_build_array(${q(reason)})
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '1 hour';
`
  );
}

async function startRun(db: PsqlSession, source: string, sinceHours: number, dry: boolean): Promise<number> {
  if (dry) return -1;
  const meta = JSON.stringify({ mode: "heartbeat_hook" });
  const out = await db.queryValue(
    `
WITH created AS (
  INSERT INTO cortana_memory_ingest_runs (source, since_hours, status, metadata)
  VALUES (${q(source)}, ${sinceHours}, 'created', ${q(meta)}::jsonb)
  RETURNING id
)
UPDATE cortana_memory_ingest_runs r
SET status = 'running'
FROM created c
WHERE r.id = c.id
RETURNING r.id;
`
  );
  return Number.parseInt(out, 10);
}

async function finishRun(db: PsqlSession, runId: number, counts: Record<string, number>, errs: string[], dry: boolean): Promise<void> {
  if (dry || runId < 0) return;
  const status = errs.length ? "failed" : "completed";
  await db.execute(
    `UPDATE cortana_memory_ingest_runs SET finished_at=NOW(), status=${q(status)}, inserted_episodic=${counts.e}, inserted_semantic=${counts.s}, inserted_procedural=${counts.p}, inserted_provenance=${counts.v}, errors=${q(JSON.stringify(errs))}::jsonb WHERE id=${runId};`
  );
}

async function markRunFailed(db: PsqlSession, runId: number, err: string, dry: boolean): Promise<void> {
  if (dry || runId < 0) return;
  await db.execute(
    `UPDATE cortana_memory_ingest_runs SET finished_at=NOW(), status='failed', errors=${q(JSON.stringify([err]))}::jsonb WHERE id=${runId};`
  );
}

async function prov(db: PsqlSession, runId: number, tier: string, memoryId: number, stype: string, sref: string, shash: string, dry: boolean): Promise<boolean> {
  const sql = `INSERT INTO cortana_memory_provenance (memory_tier, memory_id, source_type, source_ref, source_hash, ingest_run_id, extractor_version) VALUES (${q(tier)}, ${memoryId}, ${q(stype)}, ${q(sref)}, ${q(shash)}, ${runId < 0 ? "NULL" : runId}, 'v1') ON CONFLICT (memory_tier, memory_id, source_type, source_ref) DO NOTHING RETURNING id;`;
  if (dry) return true;
  return Boolean(await db.queryValue(sql));
}

async function ingestDaily(db: PsqlSession, runId: number, since: Date, counts: Record<string, number>, dry: boolean, useQualityGate: boolean): Promise<void> {
  const files = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
  for (const name of files.sort()) {
    const filePath = path.join(MEMORY_DIR, name);
    const stat = fs.statSync(filePath);
    const mtime = new Date(stat.mtimeMs);
    if (mtime < since) continue;

    const text = fs.readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    const summary = `Daily memory snapshot from ${name}`;
    const details = lines.slice(0, 40).join("\\n").slice(0, 6000);
    const gate = await qualityGate((summary + "\n" + details).slice(0, 2000), useQualityGate, dry);
    if (gate.verdict === "archive") continue;

    const sref = filePath;
    const hashv = fp(sref, summary, details);
    const sql = `INSERT INTO cortana_memory_episodic (happened_at, summary, details, tags, salience, trust, recency_weight, source_type, source_ref, fingerprint, metadata) VALUES (${q(mtime.toISOString())}, ${q(summary)}, ${q(details)}, ARRAY['daily_memory','heartbeat_ingest'], 0.65, 0.75, 1.0, 'daily_markdown', ${q(sref)}, ${q(hashv)}, ${q(JSON.stringify({ line_count: lines.length }))}::jsonb) ON CONFLICT (source_type, source_ref, fingerprint) DO NOTHING RETURNING id;`;

    if (dry) {
      counts.e += 1;
      counts.v += 1;
      continue;
    }

    const out = await db.queryValue(sql);
    if (out) {
      counts.e += 1;
      if (await prov(db, runId, "episodic", Number(out), "daily_markdown", sref, hashv, dry)) {
        counts.v += 1;
      }
    }
  }
}

async function ingestFeedback(db: PsqlSession, runId: number, since: Date, counts: Record<string, number>, dry: boolean, useQualityGate: boolean): Promise<void> {
  const rows = await db.queryRows(
    `SELECT id, timestamp::text, COALESCE(feedback_type,''), COALESCE(context,''), COALESCE(lesson,'') FROM cortana_feedback WHERE timestamp >= ${q(since.toISOString())} ORDER BY timestamp ASC;`
  );

  for (const row of rows) {
    if (!row) continue;
    const parts = row.split("|");
    if (parts.length < 5) continue;
    const [i, ts, t, ctx, lesson] = parts;
    const sref = `cortana_feedback:${i}`;
    const epiFp = fp(sref, t, ctx, lesson);
    const gate = await qualityGate((lesson || ctx || t).slice(0, 2000), useQualityGate, dry);
    if (gate.verdict === "archive") continue;

    if (dry) {
      counts.e += 1;
      counts.s += 1;
      counts.p += 1;
      counts.v += 3;
      continue;
    }

    const e = await db.queryValue(
      `INSERT INTO cortana_memory_episodic (happened_at, summary, details, tags, salience, trust, recency_weight, source_type, source_ref, fingerprint, metadata) VALUES (${q(ts)}, ${q(`Feedback ${t} recorded`)}, ${q(`Context: ${ctx}\\nLesson: ${lesson}`)}, ARRAY['feedback',${q(t)}], 0.85, 0.95, 1.0, 'feedback', ${q(sref)}, ${q(epiFp)}, ${q(JSON.stringify({ feedback_type: t }))}::jsonb) ON CONFLICT (source_type, source_ref, fingerprint) DO NOTHING RETURNING id;`
    );
    if (e) {
      counts.e += 1;
      if (await prov(db, runId, "episodic", Number(e), "feedback", sref, epiFp, dry)) {
        counts.v += 1;
      }
    }

    const ft = t === "preference" ? "preference" : t === "fact" ? "fact" : "rule";
    const semFp = fp(sref, ft, lesson || ctx);
    const sem = await db.queryValue(
      `INSERT INTO cortana_memory_semantic (fact_type, subject, predicate, object_value, confidence, trust, stability, first_seen_at, last_seen_at, source_type, source_ref, fingerprint, metadata) VALUES (${q(ft)}, 'hamel', 'guidance', ${q(lesson || ctx)}, 0.92, 0.95, 0.80, ${q(ts)}, ${q(ts)}, 'feedback', ${q(sref)}, ${q(semFp)}, ${q(JSON.stringify({ feedback_type: t }))}::jsonb) ON CONFLICT (fact_type, subject, predicate, object_value) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at RETURNING id;`
    );
    if (sem) {
      counts.s += 1;
      if (await prov(db, runId, "semantic", Number(sem), "feedback", sref, semFp, dry)) {
        counts.v += 1;
      }
    }

    const steps = JSON.stringify([
      "Detect correction signal",
      "Acknowledge briefly",
      "Log feedback",
      "Update memory/rules",
      "Confirm lesson",
    ]);
    const procFp = fp(sref, "proc", lesson || ctx);
    const proc = await db.queryValue(
      `INSERT INTO cortana_memory_procedural (workflow_name, trigger_context, steps_json, expected_outcome, derived_from_feedback_id, trust, source_type, source_ref, fingerprint, metadata) VALUES (${q(`Apply feedback: ${t}`)}, ${q((ctx || t).slice(0, 500))}, ${q(steps)}::jsonb, 'Future behavior aligns with correction', ${i}, 0.93, 'feedback', ${q(sref)}, ${q(procFp)}, ${q(JSON.stringify({ feedback_type: t }))}::jsonb) ON CONFLICT (workflow_name, trigger_context, fingerprint) DO NOTHING RETURNING id;`
    );
    if (proc) {
      counts.p += 1;
      if (await prov(db, runId, "procedural", Number(proc), "feedback", sref, procFp, dry)) {
        counts.v += 1;
      }
    }
  }
}

async function updateMetrics(db: PsqlSession, dry: boolean): Promise<void> {
  const sql = `
WITH m AS (
  SELECT
    (SELECT COUNT(*) FROM cortana_memory_episodic WHERE active = TRUE) AS episodic_total,
    (SELECT COUNT(*) FROM cortana_memory_semantic WHERE active = TRUE) AS semantic_total,
    (SELECT COUNT(*) FROM cortana_memory_procedural WHERE deprecated = FALSE) AS procedural_total,
    (SELECT COUNT(*) FROM cortana_memory_archive) AS archived_total,
    (SELECT COUNT(*) FROM cortana_memory_ingest_runs WHERE started_at >= NOW() - INTERVAL '24 hours' AND status='completed') AS ingest_runs_24h,
    (SELECT COALESCE(MAX(finished_at), MAX(started_at)) FROM cortana_memory_ingest_runs) AS last_ingest_at,
    (SELECT status FROM cortana_memory_ingest_runs ORDER BY id DESC LIMIT 1) AS last_run_status
)
UPDATE cortana_self_model
SET metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{memory_engine}', jsonb_build_object(
  'episodic_total', m.episodic_total,
  'semantic_total', m.semantic_total,
  'procedural_total', m.procedural_total,
  'archived_total', m.archived_total,
  'ingest_runs_24h', m.ingest_runs_24h,
  'last_ingest_at', m.last_ingest_at,
  'last_run_status', COALESCE(m.last_run_status,'unknown'),
  'updated_at', NOW()
), true), updated_at=NOW()
FROM m WHERE id=1;
`;
  if (!dry) {
    await db.execute(sql);
  }
}

type Args = { sinceHours: number; source: string; dryRun: boolean; qualityGate: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = {
    sinceHours: 24,
    source: "heartbeat",
    dryRun: false,
    qualityGate: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--since-hours" && next) {
      args.sinceHours = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--source" && next) {
      args.source = next;
      i += 1;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--quality-gate") {
      args.qualityGate = true;
    }
  }

  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const since = new Date(Date.now() - args.sinceHours * 60 * 60 * 1000);
  const counts = { e: 0, s: 0, p: 0, v: 0 };
  const errs: string[] = [];
  let runId = -1;

  const db = new PsqlSession(DB);
  try {
    if (args.dryRun) {
      try {
        await ingestDaily(db, runId, since, counts, args.dryRun, args.qualityGate);
        await ingestFeedback(db, runId, since, counts, args.dryRun, args.qualityGate);
      } catch (ex) {
        errs.push(String(ex));
      }
    } else {
      await finalizeStaleRuns(db, args.dryRun);
      runId = await startRun(db, args.source, args.sinceHours, args.dryRun);

      await db.execute("BEGIN");
      try {
        await ingestDaily(db, runId, since, counts, args.dryRun, args.qualityGate);
        await ingestFeedback(db, runId, since, counts, args.dryRun, args.qualityGate);
        await finishRun(db, runId, counts, errs, args.dryRun);
        await updateMetrics(db, args.dryRun);
        await db.execute("COMMIT");
      } catch (ex) {
        await db.execute("ROLLBACK");
        errs.push(String(ex));
        await markRunFailed(db, runId, String(ex), args.dryRun);
      }
    }
  } finally {
    db.close();
  }

  const out = {
    ok: errs.length === 0,
    run_id: runId,
    since_hours: args.sinceHours,
    inserted: {
      episodic: counts.e,
      semantic: counts.s,
      procedural: counts.p,
      provenance: counts.v,
    },
    errors: errs,
  };

  console.log(JSON.stringify(out, null, 2));
  if (errs.length) {
    process.exit(1);
  }
}

main();
