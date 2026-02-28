#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path

PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql"
DB = "cortana"
USAGE_HANDLER = "/Users/hd/openclaw/skills/telegram-usage/handler.js"
COOLDOWN_SEC = 15 * 60
HYSTERESIS_STEPS = 2


def sh(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True)


def psql(sql: str, at: bool = False) -> str:
    cmd = [PSQL, DB, "-v", "ON_ERROR_STOP=1"]
    if at:
        cmd.extend(["-At", "-q", "-X"])
    cmd.extend(["-c", sql])
    proc = sh(cmd)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "psql failed")
    return proc.stdout.strip()


def sql_escape(s: str) -> str:
    return s.replace("'", "''")


def parse_usage(raw: str) -> dict:
    spend = burn = projected = pct = 0.0
    parser = "default_zero"

    txt = (raw or "").strip()
    if not txt:
        return {"spend": 0.0, "burn": 0.0, "projected": 0.0, "pct": 0.0, "parser": parser}

    try:
        d = json.loads(txt)
        parser = "json"

        def pick(*keys):
            for k in keys:
                if isinstance(d, dict) and k in d and d[k] is not None:
                    try:
                        return float(d[k])
                    except Exception:
                        pass
            return None

        spend = pick("spend_to_date", "spend", "cost", "total_spend") or 0.0
        burn = pick("burn_rate", "daily_burn", "rate") or 0.0
        projected = pick("projected", "projected_monthly", "forecast") or 0.0
        pct = pick("pct_used", "percent_used", "usage_pct") or 0.0
        return {"spend": spend, "burn": burn, "projected": projected, "pct": pct, "parser": parser}
    except Exception:
        pass

    parser = "text"
    m_quota = re.search(r"quota\s*:\s*[^\d]*(\d+(?:\.\d+)?)%", txt, flags=re.I)
    if m_quota:
        # handler shows remaining quota; convert to used pct.
        remaining = float(m_quota.group(1))
        pct = max(0.0, min(100.0, round(100.0 - remaining, 2)))

    m_spend = re.search(r"(?:spend|cost|used)\s*[:=]?\s*\$?\s*(\d+(?:\.\d+)?)", txt, flags=re.I)
    if m_spend:
        spend = float(m_spend.group(1))

    # If only percent exists, derive projected from a $100 nominal cap so downstream math remains sane.
    if spend == 0 and pct > 0:
        projected = pct
    return {"spend": spend, "burn": burn, "projected": projected, "pct": pct, "parser": parser}


def target_tier(pct: float) -> int:
    if pct >= 90:
        return 3
    if pct >= 75:
        return 2
    if pct >= 50:
        return 1
    return 0


def main() -> None:
    os.environ["PATH"] = "/opt/homebrew/opt/postgresql@17/bin:" + os.environ.get("PATH", "")

    usage_proc = sh(["node", USAGE_HANDLER])
    usage_raw = usage_proc.stdout or ""
    parsed = parse_usage(usage_raw)

    breakdown = {
        "parser": parsed["parser"],
        "raw": usage_raw[:4000],
        "stderr": (usage_proc.stderr or "")[:800],
    }

    psql(
        "INSERT INTO cortana_budget_log (spend_to_date, burn_rate, projected, breakdown, pct_used) VALUES ("
        f"{parsed['spend']}, {parsed['burn']}, {parsed['projected']}, '{sql_escape(json.dumps(breakdown))}'::jsonb, {parsed['pct']});"
    )

    row = psql(
        "SELECT row_to_json(t)::text FROM ("
        "SELECT id, health_score, status, budget_pct_used, throttle_tier, COALESCE(metadata,'{}'::jsonb) AS metadata "
        "FROM cortana_self_model WHERE id=1) t;",
        at=True,
    )
    current = json.loads(row) if row else {"throttle_tier": 0, "metadata": {}}
    metadata = current.get("metadata") or {}
    control = metadata.get("throttle_control") if isinstance(metadata.get("throttle_control"), dict) else {}

    pct = float(parsed["pct"])
    candidate = target_tier(pct)
    current_tier = int(current.get("throttle_tier") or 0)

    last_change_epoch = int(control.get("last_change_epoch") or 0)
    if not last_change_epoch:
        latest_change = psql(
            "SELECT EXTRACT(EPOCH FROM COALESCE(MAX(timestamp), NOW() - INTERVAL '365 days'))::bigint "
            "FROM cortana_throttle_log;",
            at=True,
        )
        try:
            last_change_epoch = int((latest_change or "0").strip())
        except Exception:
            last_change_epoch = 0

    now = int(time.time())
    pending_tier = int(control.get("pending_tier", current_tier))
    pending_hits = int(control.get("pending_hits", 0))

    tier_to_apply = current_tier
    throttle_reason = "stable"

    if candidate == current_tier:
        pending_tier = candidate
        pending_hits = 0
        throttle_reason = "within_current_band"
    else:
        if now - last_change_epoch < COOLDOWN_SEC:
            throttle_reason = "cooldown_hold"
            pending_tier = candidate
            pending_hits = 1 if pending_tier != int(control.get("pending_tier", -1)) else max(1, pending_hits)
        else:
            if pending_tier == candidate:
                pending_hits += 1
            else:
                pending_tier = candidate
                pending_hits = 1
            throttle_reason = "hysteresis_tracking"
            if pending_hits >= HYSTERESIS_STEPS:
                tier_to_apply = candidate
                pending_hits = 0
                pending_tier = candidate
                last_change_epoch = now
                throttle_reason = "hysteresis_commit"

    crons_total = int(psql("SELECT COUNT(*) FROM (SELECT DISTINCT ON (cron_name) cron_name FROM cortana_cron_health ORDER BY cron_name, timestamp DESC) t;", at=True) or "0")
    crons_healthy = int(psql("SELECT COUNT(*) FROM (SELECT DISTINCT ON (cron_name) cron_name, status FROM cortana_cron_health ORDER BY cron_name, timestamp DESC) t WHERE status='ok';", at=True) or "0")

    crons_failing = psql("SELECT COALESCE(array_agg(cron_name), '{}') FROM (SELECT DISTINCT ON (cron_name) cron_name, status FROM cortana_cron_health ORDER BY cron_name, timestamp DESC) t WHERE status='failed';", at=True) or "{}"
    crons_missed = psql("SELECT COALESCE(array_agg(cron_name), '{}') FROM (SELECT DISTINCT ON (cron_name) cron_name, status FROM cortana_cron_health ORDER BY cron_name, timestamp DESC) t WHERE status='missed';", at=True) or "{}"
    tools_up = psql("SELECT COALESCE(array_agg(tool_name), '{}') FROM (SELECT DISTINCT ON (tool_name) tool_name, status FROM cortana_tool_health ORDER BY tool_name, timestamp DESC) t WHERE status='up';", at=True) or "{}"
    tools_down = psql("SELECT COALESCE(array_agg(tool_name), '{}') FROM (SELECT DISTINCT ON (tool_name) tool_name, status FROM cortana_tool_health ORDER BY tool_name, timestamp DESC) t WHERE status<>'up';", at=True) or "{}"

    tools_down_count = int(psql("SELECT COUNT(*) FROM (SELECT DISTINCT ON (tool_name) tool_name, status FROM cortana_tool_health ORDER BY tool_name, timestamp DESC) t WHERE status<>'up';", at=True) or "0")
    crons_fail_count = int(psql("SELECT COUNT(*) FROM (SELECT DISTINCT ON (cron_name) cron_name, status FROM cortana_cron_health ORDER BY cron_name, timestamp DESC) t WHERE status IN ('failed','missed');", at=True) or "0")

    budget_penalty = 30 if pct >= 90 else 20 if pct >= 75 else 10 if pct >= 50 else 0
    health = max(0, int(100 - 10 * tools_down_count - 5 * crons_fail_count - budget_penalty))
    status = "nominal" if health >= 80 else "degraded" if health >= 50 else "critical"

    metadata["throttle_control"] = {
        "pending_tier": pending_tier,
        "pending_hits": pending_hits,
        "last_change_epoch": last_change_epoch,
        "cooldown_sec": COOLDOWN_SEC,
        "hysteresis_steps": HYSTERESIS_STEPS,
        "last_reason": throttle_reason,
    }
    metadata["budget_parser"] = {
        "mode": parsed["parser"],
        "captured_at": int(time.time()),
    }

    psql(
        "INSERT INTO cortana_self_model ("
        "id, health_score, status, budget_used, budget_pct_used, budget_burn_rate, budget_projected, throttle_tier, "
        "crons_total, crons_healthy, crons_failing, crons_missed, tools_up, tools_down, metadata, updated_at"
        ") VALUES ("
        f"1, {health}, '{status}', {parsed['spend']}, {pct}, {parsed['burn']}, {parsed['projected']}, {tier_to_apply}, "
        f"{crons_total}, {crons_healthy}, '{sql_escape(crons_failing)}'::text[], '{sql_escape(crons_missed)}'::text[], "
        f"'{sql_escape(tools_up)}'::text[], '{sql_escape(tools_down)}'::text[], '{sql_escape(json.dumps(metadata))}'::jsonb, NOW()"
        ") ON CONFLICT (id) DO UPDATE SET "
        "health_score=EXCLUDED.health_score, status=EXCLUDED.status, budget_used=EXCLUDED.budget_used, "
        "budget_pct_used=EXCLUDED.budget_pct_used, budget_burn_rate=EXCLUDED.budget_burn_rate, budget_projected=EXCLUDED.budget_projected, "
        "throttle_tier=EXCLUDED.throttle_tier, crons_total=EXCLUDED.crons_total, crons_healthy=EXCLUDED.crons_healthy, "
        "crons_failing=EXCLUDED.crons_failing, crons_missed=EXCLUDED.crons_missed, tools_up=EXCLUDED.tools_up, tools_down=EXCLUDED.tools_down, "
        "metadata=EXCLUDED.metadata, updated_at=NOW();"
    )

    if tier_to_apply != current_tier:
        psql(
            "INSERT INTO cortana_throttle_log (tier_from, tier_to, reason, actions_taken) VALUES ("
            f"{current_tier}, {tier_to_apply}, 'budget threshold evaluation ({throttle_reason})', ARRAY['auto-check']);"
        )

    print(json.dumps({
        "ok": True,
        "budget_pct_used": pct,
        "throttle_before": current_tier,
        "throttle_after": tier_to_apply,
        "throttle_reason": throttle_reason,
        "health": health,
        "status": status,
    }))


if __name__ == "__main__":
    main()
