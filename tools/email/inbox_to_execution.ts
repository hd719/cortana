#!/usr/bin/env npx tsx
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGogEnv } from "../gog/gog-with-env.js";
import { ensureGatewayPathPrefix, readMergedGatewayEnvSources } from "../openclaw/gateway-env.js";

async function main(): Promise<void> {
  const py = String.raw`#!/usr/bin/env python3
"""Inbox-to-Execution pipeline.

Enhances Gmail triage by turning important email commitments into structured
cortana_tasks, detecting stale promises, surfacing orphan risks for briefings,
and auto-closing tasks when closure evidence appears.

Uses gog CLI for Gmail access and PostgreSQL (cortana DB) for task state.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


DATE_PATTERNS = [
    # 2026-03-14 / 2026/03/14
    re.compile(r"\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b", re.I),
    # Mar 14, 2026 / March 14
    re.compile(r"\b(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+(\d{1,2})(?:,\s*(20\d{2}))?\b", re.I),
    # 14 Mar 2026
    re.compile(r"\b(\d{1,2})\s+(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)(?:\s*,?\s*(20\d{2}))?\b", re.I),
]

MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}


@dataclass
class EmailItem:
    id: str
    thread_id: str
    subject: str
    sender: str
    recipients: str
    snippet: str
    date: datetime | None
    body: str
    gmail_url: str


class Runner:
    def __init__(self, account: str, db: str, dry_run: bool = False, verbose: bool = False):
        self.account = account
        self.db = db
        self.dry_run = dry_run
        self.verbose = verbose
        self.warnings: list[str] = []
        self.stats: dict[str, int] = {
            "scanned": 0,
            "created": 0,
            "updated": 0,
            "closed": 0,
            "stale": 0,
            "orphan": 0,
            "errors": 0,
        }

    def log(self, msg: str) -> None:
        if self.verbose:
            print(msg)

    def _run(self, cmd: list[str]) -> str:
        self.log(f"$ {' '.join(cmd)}")
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode != 0:
            raise RuntimeError((p.stderr or p.stdout or "command failed").strip())
        return p.stdout.strip()

    def _is_timeout_error(self, err: Exception | str) -> bool:
        text = str(err).lower()
        return "timed out" in text or "deadline exceeded" in text or "timeout" in text

    def gog_search(
        self,
        query: str,
        max_results: int,
        *,
        best_effort: bool = False,
        label: str | None = None,
    ) -> list[dict[str, Any]]:
        limits: list[int] = []
        for candidate in (max_results, min(max_results, 150), min(max_results, 100), min(max_results, 50)):
            if candidate > 0 and candidate not in limits:
                limits.append(candidate)

        last_err = None
        out = ""
        for limit in limits:
            commands = [
                [
                    "gog",
                    "--account",
                    self.account,
                    "gmail",
                    "search",
                    "--query",
                    query,
                    "--max",
                    str(limit),
                    "--json",
                ],
                [
                    "gog",
                    "--account",
                    self.account,
                    "gmail",
                    "search",
                    query,
                    "--max",
                    str(limit),
                    "--json",
                ],
            ]
            for cmd in commands:
                try:
                    out = self._run(cmd)
                    break
                except Exception as e:
                    last_err = e
                    continue
            if out:
                break

        if not out and last_err:
            if best_effort and self._is_timeout_error(last_err):
                context = label or query
                self.stats["errors"] += 1
                self.warnings.append(f"{context}: Gmail search timed out; continuing with partial inbox triage.")
                return []
            raise RuntimeError(str(last_err))

        data = json.loads(out) if out else []
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            for key in ("threads", "messages", "results", "items"):
                if isinstance(data.get(key), list):
                    return data[key]
        return []

    def psql(self, sql: str, *, fetch_json: bool = False) -> Any:
        if self.dry_run and sql.strip().lower().startswith(("insert", "update", "delete")):
            self.log("[dry-run] skipping write SQL")
            return []

        cmd = ["psql", self.db, "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql]
        out = self._run(cmd)
        if fetch_json:
            out = out.strip()
            if not out:
                return []
            return json.loads(out)
        return out


def parse_dt(raw: Any) -> datetime | None:
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None

    if s.isdigit():
        try:
            n = int(s)
            if n > 10_000_000_000:
                n //= 1000
            return datetime.fromtimestamp(n)
        except Exception:
            return None

    for fmt in (
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S.%f%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%a, %d %b %Y %H:%M:%S %z",
    ):
        try:
            dt = datetime.strptime(s, fmt)
            if dt.tzinfo:
                return dt.astimezone().replace(tzinfo=None)
            return dt
        except Exception:
            pass
    return None


def normalize_email(raw: dict[str, Any]) -> EmailItem:
    eid = str(raw.get("id") or raw.get("messageId") or raw.get("threadId") or "")
    thread_id = str(raw.get("threadId") or raw.get("thread_id") or eid)
    sender = str(raw.get("from") or raw.get("sender") or "Unknown")
    recipients = str(raw.get("to") or raw.get("recipients") or "")
    subject = str(raw.get("subject") or "(no subject)")
    snippet = str(raw.get("snippet") or raw.get("preview") or "")
    body = str(raw.get("body") or raw.get("text") or snippet)
    d = parse_dt(raw.get("date") or raw.get("internalDate") or raw.get("timestamp"))
    gurl = str(raw.get("gmailUrl") or f"https://mail.google.com/mail/u/0/#inbox/{thread_id}")
    return EmailItem(
        id=eid,
        thread_id=thread_id,
        subject=subject,
        sender=sender,
        recipients=recipients,
        snippet=snippet,
        date=d,
        body=body,
        gmail_url=gurl,
    )


def parse_natural_due(text: str, now: datetime) -> datetime | None:
    t = text.lower()

    if "today" in t or "eod" in t or "end of day" in t:
        return now.replace(hour=17, minute=0, second=0, microsecond=0)
    if "tomorrow" in t:
        d = now + timedelta(days=1)
        return d.replace(hour=12, minute=0, second=0, microsecond=0)
    if "eow" in t or "end of week" in t:
        days = (4 - now.weekday()) % 7
        d = now + timedelta(days=days)
        return d.replace(hour=17, minute=0, second=0, microsecond=0)
    if "next week" in t:
        d = now + timedelta(days=7)
        return d.replace(hour=12, minute=0, second=0, microsecond=0)

    for pat in DATE_PATTERNS:
        m = pat.search(text)
        if not m:
            continue
        groups = m.groups()
        try:
            if pat is DATE_PATTERNS[0]:
                y, mo, da = int(groups[0]), int(groups[1]), int(groups[2])
            elif pat is DATE_PATTERNS[1]:
                mo = MONTHS[groups[0].lower()]
                da = int(groups[1])
                y = int(groups[2]) if groups[2] else now.year
            else:
                da = int(groups[0])
                mo = MONTHS[groups[1].lower()]
                y = int(groups[2]) if groups[2] else now.year
            return datetime(y, mo, da, 12, 0, 0)
        except Exception:
            continue

    return None


def detect_commitment_and_action(email: EmailItem) -> tuple[bool, bool, bool, int]:
    text = f"{email.subject} {email.snippet} {email.body}".lower()

    response_required = bool(
        re.search(r"\b(reply|respond|response needed|let me know|can you|could you|please (review|send|confirm)|action required|follow up)\b", text)
    )
    follow_up = bool(re.search(r"\bfollow\s*up|check\s*in|circle\s*back|ping\b", text))
    commitment = bool(
        re.search(r"\b(i('ll| will)|we('ll| will)|i can|we can|i plan to|i promise|i'll get back|i'll send|i will send)\b", text)
    )

    priority = 3
    if re.search(r"\b(asap|urgent|immediately|today|deadline|overdue)\b", text):
        priority = 1
    elif response_required:
        priority = 2
    elif follow_up:
        priority = 2

    important = response_required or follow_up or priority <= 2 or commitment
    return important, response_required, follow_up, priority


def stakeholders(email: EmailItem) -> list[str]:
    vals = []
    for raw in [email.sender, email.recipients]:
        if not raw:
            continue
        parts = re.split(r"[,;]", raw)
        for p in parts:
            s = p.strip()
            if s and s not in vals:
                vals.append(s)
    return vals[:8]


def reminder_from_due(due: datetime | None, response_required: bool, follow_up: bool) -> datetime | None:
    if not due:
        return None
    if response_required:
        return due - timedelta(hours=24)
    if follow_up:
        return due - timedelta(hours=12)
    return due - timedelta(hours=6)


def sql_q(s: str) -> str:
    return s.replace("'", "''")


def upsert_task(r: Runner, email: EmailItem, response_required: bool, follow_up: bool, priority: int, due_at: datetime | None, remind_at: datetime | None) -> None:
    thr = sql_q(email.thread_id)
    rows = r.psql(
        f"""
        SELECT COALESCE(json_agg(t), '[]'::json)::text
        FROM (
          SELECT id, status, created_at
          FROM cortana_tasks
          WHERE source='inbox-to-execution'
            AND metadata->>'thread_id'='{thr}'
          ORDER BY id DESC
          LIMIT 1
        ) t;
        """,
        fetch_json=True,
    )
    existing = rows[0] if rows else None

    meta = {
        "thread_id": email.thread_id,
        "gmail_id": email.id,
        "gmail_url": email.gmail_url,
        "sender": email.sender,
        "stakeholders": stakeholders(email),
        "response_required": response_required,
        "follow_up": follow_up,
        "commitment_detected": detect_commitment_and_action(email)[0],
        "pipeline": "inbox_to_execution",
    }

    title = f"Email follow-up: {email.subject}"
    desc = (
        f"From: {email.sender}\n"
        f"Subject: {email.subject}\n\n"
        f"Snippet: {email.snippet}\n\n"
        f"Open thread: {email.gmail_url}"
    )

    due_sql = f"'{due_at.strftime('%Y-%m-%d %H:%M:%S')}'" if due_at else "NULL"
    remind_sql = f"'{remind_at.strftime('%Y-%m-%d %H:%M:%S')}'" if remind_at else "NULL"

    if existing and existing.get("status") in {"ready", "in_progress", "backlog"}:
        sql = f"""
        UPDATE cortana_tasks
        SET
          title='{sql_q(title)}',
          description='{sql_q(desc)}',
          priority={priority},
          due_at={due_sql},
          remind_at={remind_sql},
          metadata=COALESCE(metadata, '{{}}'::jsonb) || '{sql_q(json.dumps(meta))}'::jsonb,
          updated_at=NOW()
        WHERE id={int(existing['id'])};
        """
        r.psql(sql)
        r.stats["updated"] += 1
        return

    sql = f"""
    INSERT INTO cortana_tasks (
      source, title, description, priority, status,
      due_at, remind_at, auto_executable, execution_plan, metadata
    ) VALUES (
      'inbox-to-execution',
      '{sql_q(title)}',
      '{sql_q(desc)}',
      {priority},
      'ready',
      {due_sql},
      {remind_sql},
      FALSE,
      'Review thread and send a response if required. Confirm closure evidence in Gmail.',
      '{sql_q(json.dumps(meta))}'::jsonb
    );
    """
    r.psql(sql)
    r.stats["created"] += 1


def closure_sweep(r: Runner, sent_lookback_days: int) -> None:
    rows = r.psql(
        """
        SELECT COALESCE(json_agg(t), '[]'::json)::text
        FROM (
          SELECT id, title, status, created_at, metadata
          FROM cortana_tasks
          WHERE source='inbox-to-execution'
            AND status IN ('ready','in_progress','backlog')
        ) t;
        """,
        fetch_json=True,
    )
    tasks = rows if isinstance(rows, list) else []

    sent = [
        normalize_email(x)
        for x in r.gog_search(
            f"in:sent newer_than:{sent_lookback_days}d",
            200,
            best_effort=True,
            label="closure sweep sent-thread lookup",
        )
    ]
    sent_by_thread: dict[str, list[EmailItem]] = {}
    for s in sent:
        sent_by_thread.setdefault(s.thread_id, []).append(s)

    for t in tasks:
        tid = int(t["id"])
        meta = t.get("metadata") or {}
        thread_id = str(meta.get("thread_id") or "")
        if not thread_id:
            continue
        replies = sent_by_thread.get(thread_id, [])
        if not replies:
            continue

        created_at = parse_dt(t.get("created_at"))
        has_post_create_reply = any((m.date and created_at and m.date >= created_at) or not created_at for m in replies)
        if not has_post_create_reply:
            continue

        top = sorted([m for m in replies if m.date], key=lambda x: x.date or datetime.min, reverse=True)
        reply = top[0] if top else replies[0]
        closure = {
            "closed_by": "reply_sent",
            "closed_at": (reply.date.isoformat() if reply.date else datetime.now().isoformat()),
            "closure_subject": reply.subject,
        }
        sql = f"""
        UPDATE cortana_tasks
        SET
          status='completed',
          completed_at=COALESCE(completed_at, NOW()),
          outcome=COALESCE(outcome, 'Auto-closed: reply sent in thread.'),
          metadata=COALESCE(metadata, '{{}}'::jsonb) || '{sql_q(json.dumps(closure))}'::jsonb,
          updated_at=NOW()
        WHERE id={tid}
          AND status IN ('ready','in_progress','backlog');
        """
        r.psql(sql)
        r.stats["closed"] += 1


def stale_and_orphan_scan(r: Runner, commit_lookback_days: int, sent_lookback_days: int) -> list[dict[str, Any]]:
    commits = [
        normalize_email(x)
        for x in r.gog_search(
            f"in:sent newer_than:{commit_lookback_days}d (\"I will\" OR \"I'll\" OR \"follow up\" OR \"get back\")",
            200,
            best_effort=True,
            label="stale/orphan commitment scan",
        )
    ]
    inbox = [
        normalize_email(x)
        for x in r.gog_search(
            f"in:inbox newer_than:{commit_lookback_days}d",
            300,
            best_effort=True,
            label="stale/orphan inbox scan",
        )
    ]
    sent = [
        normalize_email(x)
        for x in r.gog_search(
            f"in:sent newer_than:{sent_lookback_days}d",
            300,
            best_effort=True,
            label="stale/orphan sent-thread lookup",
        )
    ]

    inbox_threads: dict[str, list[EmailItem]] = {}
    sent_threads: dict[str, list[EmailItem]] = {}
    for m in inbox:
        inbox_threads.setdefault(m.thread_id, []).append(m)
    for m in sent:
        sent_threads.setdefault(m.thread_id, []).append(m)

    stale_hits: list[dict[str, Any]] = []
    for c in commits:
        if not c.thread_id:
            continue
        commit_time = c.date or datetime.min
        incoming_after = [m for m in inbox_threads.get(c.thread_id, []) if (m.date or datetime.min) > commit_time]
        outgoing_after = [m for m in sent_threads.get(c.thread_id, []) if (m.date or datetime.min) > commit_time]

        if incoming_after and not outgoing_after:
            stale_hits.append(
                {
                    "thread_id": c.thread_id,
                    "subject": c.subject,
                    "committed_at": commit_time.isoformat() if c.date else None,
                    "sender": c.recipients or c.sender,
                    "risk": "stale_commitment",
                }
            )

    for hit in stale_hits:
        thr = sql_q(hit["thread_id"])
        sql = f"""
        UPDATE cortana_tasks
        SET
          metadata=COALESCE(metadata, '{{}}'::jsonb)
            || jsonb_build_object('stale_commitment', true, 'stale_detected_at', NOW()::text),
          updated_at=NOW()
        WHERE source='inbox-to-execution'
          AND status IN ('ready','in_progress','backlog')
          AND metadata->>'thread_id'='{thr}';
        """
        r.psql(sql)
        r.stats["stale"] += 1

    orphan: list[dict[str, Any]] = []
    for c in commits:
        thr = c.thread_id
        if not thr:
            continue
        replies_after = [m for m in sent_threads.get(thr, []) if (m.date or datetime.min) > (c.date or datetime.min)]
        closure_evidence = len(replies_after) > 0

        row = r.psql(
            f"""
            SELECT COALESCE(json_agg(t), '[]'::json)::text
            FROM (
              SELECT id, status
              FROM cortana_tasks
              WHERE source='inbox-to-execution' AND metadata->>'thread_id'='{sql_q(thr)}'
              ORDER BY id DESC LIMIT 3
            ) t;
            """,
            fetch_json=True,
        )
        tasks = row if isinstance(row, list) else []
        has_closed_task = any((t.get("status") == "completed") for t in tasks)

        if not closure_evidence and not has_closed_task:
            orphan.append(
                {
                    "thread_id": thr,
                    "subject": c.subject,
                    "committed_at": c.date.isoformat() if c.date else None,
                    "risk": "orphan_commitment",
                }
            )

    seen = set()
    clean = []
    for o in orphan:
        tid = o["thread_id"]
        if tid in seen:
            continue
        seen.add(tid)
        clean.append(o)

    r.stats["orphan"] = len(clean)
    return clean


def run_pipeline(args: argparse.Namespace) -> int:
    os.environ["PATH"] = "/opt/homebrew/bin:/opt/homebrew/opt/postgresql@17/bin:/usr/local/bin:/usr/bin:/bin"

    runner = Runner(account=args.account, db=args.db, dry_run=args.dry_run, verbose=args.verbose)

    raw = runner.gog_search(args.query, args.max_emails)
    emails = [normalize_email(x) for x in raw]
    now = datetime.now()

    for e in emails:
        runner.stats["scanned"] += 1
        important, response_required, follow_up, priority = detect_commitment_and_action(e)
        if not important:
            continue

        due_at = parse_natural_due(f"{e.subject}\n{e.snippet}\n{e.body}", now)
        remind_at = reminder_from_due(due_at, response_required, follow_up)
        upsert_task(runner, e, response_required, follow_up, priority, due_at, remind_at)

    closure_sweep(runner, sent_lookback_days=args.sent_lookback_days)
    orphan = stale_and_orphan_scan(
        runner,
        commit_lookback_days=args.commit_lookback_days,
        sent_lookback_days=args.sent_lookback_days,
    )

    summary = {
        "pipeline": "inbox_to_execution",
        "ts": datetime.now().isoformat(),
        "stats": runner.stats,
        "orphan_risk": orphan[: args.orphan_limit],
        "warnings": runner.warnings,
    }

    if args.output_json:
        print(json.dumps(summary, indent=2))
    else:
        print("📥 Inbox→Execution summary")
        print(f"• scanned: {runner.stats['scanned']}")
        print(f"• tasks created: {runner.stats['created']}")
        print(f"• tasks updated: {runner.stats['updated']}")
        print(f"• auto-closed: {runner.stats['closed']}")
        print(f"• stale commitments: {runner.stats['stale']}")
        print(f"• orphan risk count: {runner.stats['orphan']}")
        if runner.warnings:
            print("\nWarnings:")
            for warning in runner.warnings:
                print(f"- {warning}")
        if orphan:
            print("\nOrphan risk (for morning brief):")
            for i, o in enumerate(orphan[: args.orphan_limit], start=1):
                print(f"{i}. {o['subject']} [thread:{o['thread_id']}] committed:{o.get('committed_at') or 'unknown'}")

    if args.outfile:
        out = Path(args.outfile)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(summary, indent=2))

    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Turn important inbox threads into executable task state, detect stale commitments, and report orphan risk.",
    )
    p.add_argument("--account", default=os.getenv("GOG_ACCOUNT", "hameldesai3@gmail.com"), help="gog account email")
    p.add_argument("--db", default=os.getenv("CORTANA_DB", "cortana"), help="PostgreSQL database name")
    p.add_argument("--query", default=os.getenv("INBOX_EXEC_QUERY", "is:unread newer_than:7d"), help="Gmail query for inbox scan")
    p.add_argument("--max-emails", type=int, default=int(os.getenv("INBOX_EXEC_MAX", "40")), help="max emails to scan")
    p.add_argument("--commit-lookback-days", type=int, default=14, help="lookback for sent commitments")
    p.add_argument("--sent-lookback-days", type=int, default=30, help="lookback for sent closure evidence")
    p.add_argument("--orphan-limit", type=int, default=10, help="max orphan risks to print")
    p.add_argument("--output-json", action="store_true", help="print summary as JSON")
    p.add_argument("--outfile", help="optional path to write JSON summary")
    p.add_argument("--dry-run", action="store_true", help="read-only mode; skip DB writes")
    p.add_argument("--verbose", action="store_true", help="verbose logs")
    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return run_pipeline(args)


if __name__ == "__main__":
    raise SystemExit(main())
`;
  const dir = mkdtempSync(join(tmpdir(), "pywrap-"));
  const script = join(dir, "script.py");
  writeFileSync(script, py, "utf8");
  const inheritedGatewayEnv = readMergedGatewayEnvSources(
    process.env.OPENCLAW_GATEWAY_PLIST || `${process.env.HOME}/Library/LaunchAgents/ai.openclaw.gateway.plist`,
  );
  const execEnv = buildGogEnv(
    {
      ...process.env,
      PATH: ensureGatewayPathPrefix(process.env.PATH),
    },
    inheritedGatewayEnv,
  );
  const proc = spawnSync("python3", [script, ...process.argv.slice(2)], { stdio: "inherit", env: execEnv });
  rmSync(dir, { recursive: true, force: true });
  if (proc.error) {
    console.error(String(proc.error));
    process.exit(1);
  }
  process.exit(proc.status ?? 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
