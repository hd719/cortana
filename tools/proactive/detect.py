#!/usr/bin/env python3
"""Proactive Opportunity Detector.

Detects near-term opportunities/risks across:
- Calendar (prep gaps, conflicts, travel buffers)
- Portfolio (earnings <=48h, unusual volume, sector rotation)
- Email (urgency and follow-up risk)
- Behavioral patterns (time/day predictions from cortana_patterns)
- Cross-signal correlation (calendar+email topic overlap)

Writes confidence-gated signals to DB and mirrors high-confidence items into
cortana_proactive_suggestions (+ optional cortana_tasks).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Any

ET = ZoneInfo("America/New_York")
DB_PATH = "/opt/homebrew/opt/postgresql@17/bin"
STOPWORDS = {
    "the", "and", "for", "with", "from", "that", "this", "your", "have", "will", "you", "about", "re", "fw", "fwd",
    "meeting", "call", "sync", "update", "project", "team", "today", "tomorrow", "regarding", "subject",
}
SECTOR_ETFS = {
    "Technology": "XLK",
    "Financial Services": "XLF",
    "Healthcare": "XLV",
    "Consumer Cyclical": "XLY",
    "Consumer Defensive": "XLP",
    "Energy": "XLE",
    "Industrials": "XLI",
    "Utilities": "XLU",
    "Real Estate": "XLRE",
    "Basic Materials": "XLB",
    "Communication Services": "XLC",
}


@dataclass
class Signal:
    source: str
    signal_type: str
    title: str
    summary: str
    confidence: float
    severity: str = "medium"
    opportunity: bool = True
    starts_at: str | None = None
    metadata: dict[str, Any] | None = None

    def fingerprint(self) -> str:
        key = f"{self.source}|{self.signal_type}|{self.title}|{self.starts_at or ''}"
        return re.sub(r"\s+", " ", key.strip().lower())[:300]


def sql_escape(text: str) -> str:
    return text.replace("'", "''")


def run_psql(sql: str) -> str:
    env = os.environ.copy()
    env["PATH"] = f"{DB_PATH}:{env.get('PATH', '')}"
    cmd = ["psql", "cortana", "-q", "-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql]
    out = subprocess.run(cmd, text=True, capture_output=True, env=env)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or "psql failed")
    return out.stdout.strip()


def fetch_json(sql: str) -> list[dict[str, Any]]:
    wrapped = f"SELECT COALESCE(json_agg(t), '[]'::json)::text FROM ({sql}) t;"
    raw = run_psql(wrapped)
    return json.loads(raw) if raw else []


def http_json(url: str, timeout: int = 8) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "cortana-proactive-detector/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        if value.endswith("Z"):
            return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(ET)
        return datetime.fromisoformat(value).astimezone(ET)
    except Exception:
        try:
            d = datetime.strptime(value[:10], "%Y-%m-%d")
            return d.replace(tzinfo=ET)
        except Exception:
            return None


def gog_json(args: list[str]) -> list[dict[str, Any]]:
    cmd = ["gog", "--account", os.getenv("GOG_ACCOUNT", "hameldesai3@gmail.com"), *args, "--json"]
    p = subprocess.run(cmd, text=True, capture_output=True)
    if p.returncode != 0 or not p.stdout.strip():
        return []
    try:
        data = json.loads(p.stdout)
        if isinstance(data, list):
            return data
        if isinstance(data, dict):
            return data.get("events") or data.get("messages") or data.get("threads") or []
    except Exception:
        return []
    return []


def tokenize(text: str) -> set[str]:
    toks = re.findall(r"[A-Za-z][A-Za-z0-9]{2,}", (text or "").lower())
    return {t for t in toks if t not in STOPWORDS}


def collect_calendar(now: datetime) -> list[Signal]:
    cal_id = os.getenv("PROACTIVE_CALENDAR_ID", "primary")
    to_dt = (now + timedelta(hours=48)).date().isoformat()
    events = gog_json(["calendar", "events", cal_id, "--from", "today", "--to", to_dt])
    signals: list[Signal] = []

    parsed = []
    for ev in events:
        start = parse_dt(((ev.get("start") or {}).get("dateTime") if isinstance(ev.get("start"), dict) else None) or ((ev.get("start") or {}).get("date") if isinstance(ev.get("start"), dict) else None) or ev.get("start"))
        end = parse_dt(((ev.get("end") or {}).get("dateTime") if isinstance(ev.get("end"), dict) else None) or ((ev.get("end") or {}).get("date") if isinstance(ev.get("end"), dict) else None) or ev.get("end"))
        if not start:
            continue
        if start < now or start > now + timedelta(hours=48):
            continue
        parsed.append({"id": ev.get("id", ""), "title": ev.get("summary") or "Untitled", "start": start, "end": end or (start + timedelta(hours=1)), "location": ev.get("location") or "", "desc": ev.get("description") or ""})

    parsed.sort(key=lambda x: x["start"])

    for i, ev in enumerate(parsed):
        mins = int((ev["start"] - now).total_seconds() / 60)
        title = ev["title"]

        prep_hints = any(k in (title + " " + ev["desc"]).lower() for k in ["interview", "client", "demo", "review", "presentation", "deadline"])
        if mins <= 180 and prep_hints:
            conf = 0.70 + (0.10 if mins <= 90 else 0)
            signals.append(Signal(
                source="calendar",
                signal_type="prep_needed",
                title=f"Prep window closing: {title}",
                summary=f"{title} starts in {mins}m. Recommend prep checklist now.",
                confidence=min(conf, 0.95),
                severity="high" if mins <= 90 else "medium",
                opportunity=False,
                starts_at=ev["start"].isoformat(),
                metadata={"event_id": ev["id"], "minutes_until": mins},
            ))

        if ev["location"] and mins <= 120:
            signals.append(Signal(
                source="calendar",
                signal_type="travel_buffer",
                title=f"Travel buffer: {title}",
                summary=f"{title} has location '{ev['location']}' and starts in {mins}m.",
                confidence=0.67 if mins > 60 else 0.77,
                severity="medium",
                opportunity=False,
                starts_at=ev["start"].isoformat(),
                metadata={"event_id": ev["id"], "location": ev["location"]},
            ))

        if i < len(parsed) - 1:
            nxt = parsed[i + 1]
            gap = int((nxt["start"] - ev["end"]).total_seconds() / 60)
            if gap < 10:
                signals.append(Signal(
                    source="calendar",
                    signal_type="conflict_or_tight_transition",
                    title=f"Tight calendar transition: {title} → {nxt['title']}",
                    summary=f"Only {gap}m between events. High context-switch risk.",
                    confidence=0.78 if gap <= 0 else 0.69,
                    severity="high" if gap <= 0 else "medium",
                    opportunity=False,
                    starts_at=ev["start"].isoformat(),
                    metadata={"event_a": ev["id"], "event_b": nxt["id"], "gap_minutes": gap},
                ))

    return signals


def collect_portfolio(now: datetime) -> list[Signal]:
    signals: list[Signal] = []
    try:
        port = http_json("http://localhost:3033/alpaca/portfolio")
    except Exception:
        return signals

    positions = port.get("positions") if isinstance(port, dict) else []
    symbols = [p.get("symbol") for p in positions if p.get("symbol")]
    if not symbols:
        return signals

    # Volume anomaly pass
    qurl = "https://query1.finance.yahoo.com/v7/finance/quote?" + urllib.parse.urlencode({"symbols": ",".join(symbols)})
    try:
        quote_data = http_json(qurl)
        rows = ((quote_data.get("quoteResponse") or {}).get("result") or [])
    except Exception:
        rows = []

    for r in rows:
        sym = r.get("symbol")
        vol = r.get("regularMarketVolume") or 0
        avg = r.get("averageDailyVolume3Month") or 0
        if sym and avg and vol:
            ratio = vol / avg
            if ratio >= 1.8:
                signals.append(Signal(
                    source="portfolio",
                    signal_type="unusual_volume",
                    title=f"{sym} unusual volume ({ratio:.1f}x)",
                    summary=f"{sym} trading volume is {ratio:.1f}x 3M average.",
                    confidence=min(0.60 + min((ratio - 1.8) * 0.08, 0.25), 0.92),
                    severity="medium" if ratio < 2.5 else "high",
                    opportunity=bool((r.get("regularMarketChangePercent") or 0) > 0),
                    metadata={"symbol": sym, "vol_ratio": round(ratio, 2)},
                ))

    # Earnings window + sector mapping
    held_sectors: dict[str, list[str]] = {}
    for sym in symbols[:15]:
        try:
            es_url = f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{urllib.parse.quote(sym)}?modules=calendarEvents,assetProfile"
            js = http_json(es_url)
            result = (((js.get("quoteSummary") or {}).get("result") or [{}])[0])
            ce = (result.get("calendarEvents") or {}).get("earnings") or {}
            dates = ce.get("earningsDate") or []
            next_earn = None
            if dates:
                maybe = dates[0]
                if isinstance(maybe, dict):
                    next_earn = parse_dt(maybe.get("fmt") or maybe.get("raw"))
            if next_earn and now <= next_earn <= now + timedelta(hours=48):
                hrs = int((next_earn - now).total_seconds() / 3600)
                signals.append(Signal(
                    source="portfolio",
                    signal_type="earnings_within_48h",
                    title=f"{sym} earnings in {hrs}h",
                    summary=f"Held position {sym} has earnings within 48h.",
                    confidence=0.86,
                    severity="high",
                    opportunity=False,
                    starts_at=next_earn.isoformat(),
                    metadata={"symbol": sym, "hours_until": hrs},
                ))

            sector = ((result.get("assetProfile") or {}).get("sector") or "").strip()
            if sector:
                held_sectors.setdefault(sector, []).append(sym)
        except Exception:
            continue

    # Sector rotation proxy via SPDR sector ETF 1d change
    if held_sectors:
        etfs = [SECTOR_ETFS[s] for s in held_sectors if s in SECTOR_ETFS]
        if etfs:
            try:
                s_qurl = "https://query1.finance.yahoo.com/v7/finance/quote?" + urllib.parse.urlencode({"symbols": ",".join(etfs)})
                s_rows = (((http_json(s_qurl).get("quoteResponse") or {}).get("result") or []))
                by_sym = {r.get("symbol"): (r.get("regularMarketChangePercent") or 0.0) for r in s_rows}
                sector_perf = {sector: by_sym.get(etf, 0.0) for sector, etf in SECTOR_ETFS.items() if etf in by_sym}
                if sector_perf:
                    top = max(sector_perf.items(), key=lambda kv: kv[1])
                    for sec, syms in held_sectors.items():
                        ours = sector_perf.get(sec)
                        if ours is None:
                            continue
                        spread = top[1] - ours
                        if spread >= 1.2:
                            signals.append(Signal(
                                source="portfolio",
                                signal_type="sector_rotation",
                                title=f"Sector lag signal: {sec}",
                                summary=f"Held sector {sec} trails top sector {top[0]} by {spread:.2f}% today.",
                                confidence=min(0.62 + min(spread * 0.08, 0.25), 0.9),
                                severity="medium",
                                opportunity=True,
                                metadata={"held_sector": sec, "held_symbols": syms, "top_sector": top[0], "spread_pct": round(spread, 2)},
                            ))
            except Exception:
                pass

    return signals


def collect_email(now: datetime) -> list[Signal]:
    msgs = gog_json(["gmail", "search", os.getenv("PROACTIVE_EMAIL_QUERY", "is:unread newer_than:7d"), "--max", os.getenv("PROACTIVE_EMAIL_MAX", "25")])
    signals: list[Signal] = []

    urgent_words = re.compile(r"\b(urgent|asap|immediately|deadline|final notice|action required|payment due|security alert)\b", re.I)
    followup_words = re.compile(r"\b(follow\s?up|checking in|circling back|gentle reminder|nudge)\b", re.I)

    urgent_count = 0
    old_unread = 0
    for m in msgs:
        subj = str(m.get("subject") or "")
        snippet = str(m.get("snippet") or m.get("preview") or "")
        sender = str(m.get("from") or m.get("sender") or "Unknown")
        text = f"{subj} {snippet}"
        if urgent_words.search(text):
            urgent_count += 1
            signals.append(Signal(
                source="email",
                signal_type="urgent_inbox_pattern",
                title=f"Urgent email: {subj[:80]}",
                summary=f"Urgency language detected from {sender}.",
                confidence=0.80,
                severity="high",
                opportunity=False,
                metadata={"from": sender, "subject": subj},
            ))

        if followup_words.search(text):
            signals.append(Signal(
                source="email",
                signal_type="followup_needed",
                title=f"Follow-up thread: {subj[:80]}",
                summary=f"Thread likely needs response/closure ({sender}).",
                confidence=0.71,
                severity="medium",
                opportunity=False,
                metadata={"from": sender, "subject": subj},
            ))

        d = parse_dt(str(m.get("date") or m.get("internalDate") or ""))
        if d and (now - d) > timedelta(hours=30):
            old_unread += 1

    if old_unread >= 3:
        signals.append(Signal(
            source="email",
            signal_type="unanswered_backlog",
            title=f"Inbox backlog risk ({old_unread} stale unread)",
            summary="Unread threads older than ~30h may need triage block.",
            confidence=min(0.58 + old_unread * 0.05, 0.85),
            severity="medium",
            opportunity=False,
            metadata={"stale_unread_count": old_unread},
        ))

    if urgent_count >= 2:
        signals.append(Signal(
            source="email",
            signal_type="urgency_cluster",
            title=f"Urgency cluster ({urgent_count} threads)",
            summary="Multiple urgent emails detected; recommend proactive response window.",
            confidence=min(0.66 + urgent_count * 0.05, 0.9),
            severity="high",
            opportunity=False,
            metadata={"urgent_count": urgent_count},
        ))

    return signals


def collect_behavioral(now: datetime) -> list[Signal]:
    dow = now.weekday()
    hour = now.hour
    rows = fetch_json(
        "SELECT pattern_type, value, day_of_week, metadata, COUNT(*)::int AS n "
        "FROM cortana_patterns "
        f"WHERE day_of_week = {dow} AND timestamp > NOW() - INTERVAL '120 days' "
        "GROUP BY pattern_type, value, day_of_week, metadata ORDER BY n DESC LIMIT 20"
    )
    signals: list[Signal] = []

    for r in rows:
        ptype = r.get("pattern_type")
        value = str(r.get("value") or "")
        n = int(r.get("n") or 0)
        t = None
        try:
            t = datetime.strptime(value, "%H:%M").time()
        except Exception:
            pass
        if not t:
            continue

        target = now.replace(hour=t.hour, minute=t.minute, second=0, microsecond=0)
        delta_m = abs(int((target - now).total_seconds() / 60))
        if delta_m <= 90 and ptype in {"wake", "sleep_check"}:
            conf = min(0.50 + n * 0.03, 0.88)
            signals.append(Signal(
                source="behavior",
                signal_type="routine_prediction",
                title=f"Expected {ptype.replace('_', ' ')} window",
                summary=f"Historical {ptype} around {value} on this weekday (n={n}).",
                confidence=conf,
                severity="low",
                opportunity=True,
                starts_at=target.isoformat(),
                metadata={"pattern_type": ptype, "value": value, "count": n, "current_hour": hour},
            ))

    return signals


def correlate(signals: list[Signal]) -> list[Signal]:
    out: list[Signal] = []
    calendar = [s for s in signals if s.source == "calendar"]
    email = [s for s in signals if s.source == "email"]

    for c in calendar:
        c_tokens = tokenize(c.title + " " + c.summary)
        if not c_tokens:
            continue
        for e in email:
            e_tokens = tokenize(e.title + " " + e.summary)
            overlap = c_tokens.intersection(e_tokens)
            if len(overlap) >= 2:
                conf = min(0.68 + 0.04 * len(overlap), 0.93)
                out.append(Signal(
                    source="cross_signal",
                    signal_type="calendar_email_correlation",
                    title="Meeting prep likely needed from email context",
                    summary=f"Calendar + email overlap: {', '.join(sorted(list(overlap))[:5])}",
                    confidence=conf,
                    severity="high" if conf >= 0.8 else "medium",
                    opportunity=False,
                    metadata={"calendar_title": c.title, "email_title": e.title, "token_overlap": sorted(list(overlap))[:8]},
                ))

    return out


def persist(run_id: int, signals: list[Signal], min_conf: float, create_tasks: bool) -> tuple[int, int]:
    inserted = 0
    suggested = 0

    for s in signals:
        if s.confidence < min_conf:
            continue

        fp = s.fingerprint()
        meta = json.dumps(s.metadata or {})
        sql = (
            "INSERT INTO cortana_proactive_signals "
            "(run_id, source, signal_type, title, summary, confidence, severity, opportunity, starts_at, fingerprint, metadata) VALUES "
            f"({run_id}, '{sql_escape(s.source)}', '{sql_escape(s.signal_type)}', '{sql_escape(s.title)}', "
            f"'{sql_escape(s.summary)}', {s.confidence:.3f}, '{sql_escape(s.severity)}', {'TRUE' if s.opportunity else 'FALSE'}, "
            f"{('NULL' if not s.starts_at else "'" + sql_escape(s.starts_at) + "'")}, '{sql_escape(fp)}', '{sql_escape(meta)}'::jsonb) "
            "ON CONFLICT (fingerprint) DO NOTHING RETURNING id;"
        )
        sid = run_psql(sql)
        if not sid:
            continue
        inserted += 1

        suggestion = f"{s.title} — {s.summary}"
        run_psql(
            "INSERT INTO cortana_proactive_suggestions (source, suggestion, status, metadata) VALUES "
            f"('proactive-detector', '{sql_escape(suggestion)}', 'ready', "
            f"'{sql_escape(json.dumps({'signal_id': int(sid), 'confidence': s.confidence, 'signal_type': s.signal_type}))}'::jsonb);"
        )
        suggested += 1

        if create_tasks and s.confidence >= 0.82:
            title = f"Proactive: {s.title}"
            run_psql(
                "INSERT INTO cortana_tasks (source, title, description, priority, status, auto_executable, execution_plan, metadata) VALUES "
                f"('proactive-detector', '{sql_escape(title)}', '{sql_escape(s.summary)}', 2, 'ready', FALSE, "
                "'Review proactively surfaced risk/opportunity and act manually if needed.', "
                f"'{sql_escape(json.dumps({'signal_id': int(sid), 'confidence': s.confidence, 'source': s.source}))}'::jsonb);"
            )

    return inserted, suggested


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-confidence", type=float, default=float(os.getenv("PROACTIVE_MIN_CONFIDENCE", "0.66")))
    ap.add_argument("--create-tasks", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    now = datetime.now(timezone.utc).astimezone(ET)
    started = now.isoformat()
    run_id = int(run_psql("INSERT INTO cortana_proactive_detector_runs (status, started_at, metadata) VALUES ('running', NOW(), '{}'::jsonb) RETURNING id;"))

    all_signals: list[Signal] = []
    errors: list[str] = []

    for collector in (collect_calendar, collect_portfolio, collect_email, collect_behavioral):
        try:
            all_signals.extend(collector(now))
        except Exception as e:
            errors.append(f"{collector.__name__}: {e}")

    all_signals.extend(correlate(all_signals))
    all_signals.sort(key=lambda s: s.confidence, reverse=True)

    if args.dry_run:
        print(json.dumps({
            "run_id": run_id,
            "started": started,
            "min_confidence": args.min_confidence,
            "signals": [asdict(s) for s in all_signals if s.confidence >= args.min_confidence],
            "errors": errors,
        }, indent=2))
        run_psql(
            "UPDATE cortana_proactive_detector_runs SET status='completed', finished_at=NOW(), "
            f"signals_total={len(all_signals)}, signals_gated={len([s for s in all_signals if s.confidence >= args.min_confidence])}, "
            f"errors='{sql_escape(json.dumps(errors))}'::jsonb WHERE id={run_id};"
        )
        return 0

    inserted, suggested = persist(run_id, all_signals, min_conf=args.min_confidence, create_tasks=args.create_tasks)
    run_psql(
        "UPDATE cortana_proactive_detector_runs SET status='completed', finished_at=NOW(), "
        f"signals_total={len(all_signals)}, signals_gated={inserted}, suggestions_created={suggested}, "
        f"errors='{sql_escape(json.dumps(errors))}'::jsonb WHERE id={run_id};"
    )

    print(json.dumps({
        "run_id": run_id,
        "signals_total": len(all_signals),
        "signals_persisted": inserted,
        "suggestions_created": suggested,
        "min_confidence": args.min_confidence,
        "errors": errors,
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
