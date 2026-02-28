#!/usr/bin/env python3
import argparse, hashlib, json, subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

WORKSPACE = Path('/Users/hd/openclaw')
MEMORY_DIR = WORKSPACE / 'memory'
PSQL = '/opt/homebrew/opt/postgresql@17/bin/psql'
DB = 'cortana'


class PsqlSession:
    END_MARKER = '__OPENCLAW_SQL_DONE__'

    def __init__(self, db_name):
        self.proc = subprocess.Popen(
            [PSQL, db_name, '-q', '-v', 'ON_ERROR_STOP=1', '-At'],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

    def _run(self, sql):
        if not self.proc.stdin or not self.proc.stdout:
            raise RuntimeError('psql session unavailable')

        payload = f"{sql.rstrip(';')};\n\\echo {self.END_MARKER}\n"
        self.proc.stdin.write(payload)
        self.proc.stdin.flush()

        lines = []
        while True:
            line = self.proc.stdout.readline()
            if line == '':
                code = self.proc.poll()
                tail = ''.join(lines).strip()
                raise RuntimeError(f'psql session terminated (code={code}): {tail}')
            txt = line.rstrip('\n')
            if txt == self.END_MARKER:
                break
            lines.append(txt)

        out = '\n'.join(lines).strip()
        if out.startswith('ERROR:') or '\nERROR:' in out:
            raise RuntimeError(out)
        return out

    def execute(self, sql):
        self._run(sql)

    def query_value(self, sql):
        out = self._run(sql)
        if not out:
            return ''
        return out.splitlines()[0]

    def query_rows(self, sql):
        out = self._run(sql)
        return out.splitlines() if out else []

    def close(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(timeout=2)


def q(v):
    if v is None:
        return 'NULL'
    return "'" + str(v).replace("'", "''") + "'"


def fp(*parts):
    h = hashlib.sha256()
    for p in parts:
        h.update((p or '').encode())
        h.update(b'|')
    return h.hexdigest()[:32]


def quality_gate(text, enabled, dry):
    if not enabled:
        return {'verdict': 'promote'}
    gate = WORKSPACE / 'tools' / 'memory' / 'memory_quality_gate.py'
    if not gate.exists():
        return {'verdict': 'promote', 'reason': 'gate_missing'}
    try:
        proc = subprocess.run(['python3', str(gate), '--text', text, '--dry-run'], capture_output=True, text=True)
        if proc.returncode != 0:
            return {'verdict': 'hold', 'reason': 'gate_error'}
        data = json.loads((proc.stdout or '{}').strip() or '{}')
        return data if isinstance(data, dict) else {'verdict': 'hold'}
    except Exception:
        return {'verdict': 'hold', 'reason': 'gate_exception'}


def finalize_stale_runs(db, dry):
    if dry:
        return
    reason = 'Stale run auto-finalized (exceeded 1hr TTL)'
    db.execute(
        f"""
UPDATE cortana_memory_ingest_runs
SET status = 'failed',
    finished_at = NOW(),
    errors = jsonb_build_array({q(reason)})
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '1 hour';
"""
    )


def start_run(db, source, since_hours, dry):
    if dry:
        return -1
    meta = json.dumps({'mode': 'heartbeat_hook'})
    return int(
        db.query_value(
            f"""
WITH created AS (
  INSERT INTO cortana_memory_ingest_runs (source, since_hours, status, metadata)
  VALUES ({q(source)}, {since_hours}, 'created', {q(meta)}::jsonb)
  RETURNING id
)
UPDATE cortana_memory_ingest_runs r
SET status = 'running'
FROM created c
WHERE r.id = c.id
RETURNING r.id;
"""
        )
    )


def finish_run(db, run_id, c, errs, dry):
    if dry or run_id < 0:
        return
    status = 'failed' if errs else 'completed'
    db.execute(
        f"UPDATE cortana_memory_ingest_runs SET finished_at=NOW(), status={q(status)}, inserted_episodic={c['e']}, inserted_semantic={c['s']}, inserted_procedural={c['p']}, inserted_provenance={c['v']}, errors={q(json.dumps(errs))}::jsonb WHERE id={run_id};"
    )


def mark_run_failed(db, run_id, err, dry):
    if dry or run_id < 0:
        return
    db.execute(
        f"UPDATE cortana_memory_ingest_runs SET finished_at=NOW(), status='failed', errors={q(json.dumps([err]))}::jsonb WHERE id={run_id};"
    )


def prov(db, run_id, tier, memory_id, stype, sref, shash, dry):
    sql = f"INSERT INTO cortana_memory_provenance (memory_tier, memory_id, source_type, source_ref, source_hash, ingest_run_id, extractor_version) VALUES ({q(tier)}, {memory_id}, {q(stype)}, {q(sref)}, {q(shash)}, {( 'NULL' if run_id < 0 else run_id)}, 'v1') ON CONFLICT (memory_tier, memory_id, source_type, source_ref) DO NOTHING RETURNING id;"
    if dry:
        return True
    return bool(db.query_value(sql))


def ingest_daily(db, run_id, since, c, dry, use_quality_gate=False):
    for path in sorted(MEMORY_DIR.glob('*.md')):
        if path.name == 'README.md':
            continue
        mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
        if mtime < since:
            continue
        text = path.read_text(errors='ignore')
        lines = [x.strip() for x in text.splitlines() if x.strip()]
        summary = f'Daily memory snapshot from {path.name}'
        details = '\\n'.join(lines[:40])[:6000]
        gate = quality_gate((summary + '\n' + details)[:2000], use_quality_gate, dry)
        if gate.get('verdict') == 'archive':
            continue
        sref = str(path)
        hashv = fp(sref, summary, details)
        sql = f"INSERT INTO cortana_memory_episodic (happened_at, summary, details, tags, salience, trust, recency_weight, source_type, source_ref, fingerprint, metadata) VALUES ({q(mtime.isoformat())}, {q(summary)}, {q(details)}, ARRAY['daily_memory','heartbeat_ingest'], 0.65, 0.75, 1.0, 'daily_markdown', {q(sref)}, {q(hashv)}, {q(json.dumps({'line_count': len(lines)}))}::jsonb) ON CONFLICT (source_type, source_ref, fingerprint) DO NOTHING RETURNING id;"
        if dry:
            c['e'] += 1
            c['v'] += 1
            continue
        out = db.query_value(sql)
        if out:
            c['e'] += 1
            if prov(db, run_id, 'episodic', int(out), 'daily_markdown', sref, hashv, dry):
                c['v'] += 1


def ingest_feedback(db, run_id, since, c, dry, use_quality_gate=False):
    rows = db.query_rows(
        f"SELECT id, timestamp::text, COALESCE(feedback_type,''), COALESCE(context,''), COALESCE(lesson,'') FROM cortana_feedback WHERE timestamp >= {q(since.isoformat())} ORDER BY timestamp ASC;"
    )
    for row in rows:
        if not row:
            continue
        i, ts, t, ctx, lesson = row.split('|', 4)
        sref = f'cortana_feedback:{i}'
        epi_fp = fp(sref, t, ctx, lesson)
        gate = quality_gate((lesson or ctx or t)[:2000], use_quality_gate, dry)
        if gate.get('verdict') == 'archive':
            continue
        if dry:
            c['e'] += 1
            c['s'] += 1
            c['p'] += 1
            c['v'] += 3
            continue

        e = db.query_value(
            f"INSERT INTO cortana_memory_episodic (happened_at, summary, details, tags, salience, trust, recency_weight, source_type, source_ref, fingerprint, metadata) VALUES ({q(ts)}, {q('Feedback ' + t + ' recorded')}, {q('Context: ' + ctx + '\\nLesson: ' + lesson)}, ARRAY['feedback',{q(t)}], 0.85, 0.95, 1.0, 'feedback', {q(sref)}, {q(epi_fp)}, {q(json.dumps({'feedback_type': t}))}::jsonb) ON CONFLICT (source_type, source_ref, fingerprint) DO NOTHING RETURNING id;"
        )
        if e:
            c['e'] += 1
            if prov(db, run_id, 'episodic', int(e), 'feedback', sref, epi_fp, dry):
                c['v'] += 1

        ft = 'preference' if t == 'preference' else ('fact' if t == 'fact' else 'rule')
        sem_fp = fp(sref, ft, lesson or ctx)
        sem = db.query_value(
            f"INSERT INTO cortana_memory_semantic (fact_type, subject, predicate, object_value, confidence, trust, stability, first_seen_at, last_seen_at, source_type, source_ref, fingerprint, metadata) VALUES ({q(ft)}, 'hamel', 'guidance', {q(lesson or ctx)}, 0.92, 0.95, 0.80, {q(ts)}, {q(ts)}, 'feedback', {q(sref)}, {q(sem_fp)}, {q(json.dumps({'feedback_type': t}))}::jsonb) ON CONFLICT (fact_type, subject, predicate, object_value) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at RETURNING id;"
        )
        if sem:
            c['s'] += 1
            if prov(db, run_id, 'semantic', int(sem), 'feedback', sref, sem_fp, dry):
                c['v'] += 1

        steps = json.dumps(['Detect correction signal', 'Acknowledge briefly', 'Log feedback', 'Update memory/rules', 'Confirm lesson'])
        proc_fp = fp(sref, 'proc', lesson or ctx)
        proc = db.query_value(
            f"INSERT INTO cortana_memory_procedural (workflow_name, trigger_context, steps_json, expected_outcome, derived_from_feedback_id, trust, source_type, source_ref, fingerprint, metadata) VALUES ({q('Apply feedback: ' + t)}, {q((ctx or t)[:500])}, {q(steps)}::jsonb, 'Future behavior aligns with correction', {i}, 0.93, 'feedback', {q(sref)}, {q(proc_fp)}, {q(json.dumps({'feedback_type': t}))}::jsonb) ON CONFLICT (workflow_name, trigger_context, fingerprint) DO NOTHING RETURNING id;"
        )
        if proc:
            c['p'] += 1
            if prov(db, run_id, 'procedural', int(proc), 'feedback', sref, proc_fp, dry):
                c['v'] += 1


def update_metrics(db, dry):
    sql = """
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
"""
    if not dry:
        db.execute(sql)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since-hours', type=int, default=24)
    ap.add_argument('--source', default='heartbeat')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--quality-gate', action='store_true', help='run memory_quality_gate before ingesting')
    a = ap.parse_args()

    since = datetime.now(timezone.utc) - timedelta(hours=a.since_hours)
    c = {'e': 0, 's': 0, 'p': 0, 'v': 0}
    errs = []
    run_id = -1

    if a.dry_run:
        run_id = -1
        db = PsqlSession(DB)
        try:
            ingest_daily(db, run_id, since, c, a.dry_run, a.quality_gate)
            ingest_feedback(db, run_id, since, c, a.dry_run, a.quality_gate)
        except Exception as ex:
            errs.append(str(ex))
        finally:
            db.close()
    else:
        db = PsqlSession(DB)
        try:
            finalize_stale_runs(db, a.dry_run)
            run_id = start_run(db, a.source, a.since_hours, a.dry_run)

            db.execute('BEGIN')
            try:
                ingest_daily(db, run_id, since, c, a.dry_run, a.quality_gate)
                ingest_feedback(db, run_id, since, c, a.dry_run, a.quality_gate)
                finish_run(db, run_id, c, errs, a.dry_run)
                update_metrics(db, a.dry_run)
                db.execute('COMMIT')
            except Exception as ex:
                db.execute('ROLLBACK')
                errs.append(str(ex))
                mark_run_failed(db, run_id, str(ex), a.dry_run)
        finally:
            db.close()

    out = {
        'ok': not errs,
        'run_id': run_id,
        'since_hours': a.since_hours,
        'inserted': {'episodic': c['e'], 'semantic': c['s'], 'procedural': c['p'], 'provenance': c['v']},
        'errors': errs,
    }
    print(json.dumps(out, indent=2))
    if errs:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
