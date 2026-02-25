#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from urllib.request import urlopen

PSQL_BIN = "/opt/homebrew/opt/postgresql@17/bin/psql"
WHOOP_SLEEP_URL = "http://localhost:3033/whoop/sleep"
WHOOP_DATA_URL = "http://localhost:3033/whoop/data"
WHOOP_STRAIN_URL = "http://localhost:3033/whoop/strain"


@dataclass
class SleepInputs:
    recovery_score: float
    sleep_hours: float
    strain: float
    back_to_back_heavy: bool
    next_day_events: int
    booked_hours: float
    target_date: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Adaptive Sleep Protocol Orchestrator (Whoop + Calendar + Strain)"
    )
    parser.add_argument("--date", help="Protocol date (YYYY-MM-DD). Default: tomorrow")
    parser.add_argument("--wake-time", default="05:45", help="Target wake time HH:MM (24h)")
    parser.add_argument("--json", action="store_true", help="Output JSON instead of Telegram text")
    parser.add_argument("--dry-run", action="store_true", help="Do not write adherence row to DB")
    return parser.parse_args()


def get_target_date(date_arg: str | None) -> date:
    if date_arg:
        return date.fromisoformat(date_arg)
    return (datetime.now() + timedelta(days=1)).date()


def fetch_json_url(url: str) -> Any:
    with urlopen(url, timeout=8) as r:
        return json.loads(r.read().decode("utf-8"))


def fetch_whoop_sleep() -> dict[str, Any]:
    try:
        data = fetch_json_url(WHOOP_SLEEP_URL)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    try:
        data = fetch_json_url(WHOOP_DATA_URL)
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def fetch_strain() -> dict[str, Any]:
    for url in (WHOOP_STRAIN_URL, WHOOP_DATA_URL):
        try:
            data = fetch_json_url(url)
            if isinstance(data, dict):
                return data
        except Exception:
            continue
    return {}


def parse_recovery_sleep_hours(payload: dict[str, Any]) -> tuple[float, float]:
    recovery = first_numeric(payload, [
        "recovery_score",
        "recovery",
        "score",
        "latest.recovery.score",
        "sleep.recovery_score",
    ], default=0.0)

    sleep_hours = first_numeric(payload, [
        "sleep_hours",
        "hours",
        "sleep.duration_hours",
        "total_sleep_hours",
    ], default=0.0)

    if sleep_hours <= 0:
        sleep_min = first_numeric(payload, ["sleep_minutes", "sleep.duration_minutes", "total_sleep_minutes"], default=0.0)
        if sleep_min > 0:
            sleep_hours = sleep_min / 60.0

    if recovery <= 1.0:
        recovery = recovery * 100.0

    return recovery, sleep_hours


def parse_strain(payload: dict[str, Any]) -> tuple[float, bool]:
    current = first_numeric(payload, ["strain", "day_strain", "latest.strain", "workout_strain"], default=0.0)

    series = first_list(payload, ["recent", "days", "strain_history", "last_3_days"])
    values: list[float] = []
    for item in series:
        if isinstance(item, dict):
            val = first_numeric(item, ["strain", "value", "day_strain"], default=-1)
            if val >= 0:
                values.append(val)
        elif isinstance(item, (int, float)):
            values.append(float(item))

    if not values and current > 0:
        values = [current]

    heavy_threshold = 14.0
    back_to_back_heavy = len(values) >= 2 and values[0] >= heavy_threshold and values[1] >= heavy_threshold

    return current, back_to_back_heavy


def fetch_calendar_load(target: date) -> tuple[int, float]:
    from_str = target.isoformat()
    to_str = (target + timedelta(days=1)).isoformat()

    cmd = ["gog", "cal", "list", "--all", "--from", from_str, "--to", to_str, "--json", "--results-only", "--max", "100"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        return 0, 0.0

    try:
        rows = json.loads(proc.stdout)
    except Exception:
        return 0, 0.0

    if not isinstance(rows, list):
        return 0, 0.0

    total_hours = 0.0
    for ev in rows:
        if not isinstance(ev, dict):
            continue
        st = parse_dt(ev.get("start"))
        en = parse_dt(ev.get("end"))
        if st and en and en > st:
            total_hours += (en - st).total_seconds() / 3600.0

    return len(rows), round(total_hours, 2)


def parse_dt(raw: Any) -> datetime | None:
    if isinstance(raw, dict):
        raw = raw.get("dateTime") or raw.get("date")
    if not isinstance(raw, str):
        return None
    try:
        if len(raw) == 10:
            return datetime.fromisoformat(raw + "T00:00:00")
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        return None


def classify_tier(inp: SleepInputs) -> str:
    heavy_day = inp.next_day_events >= 6 or inp.booked_hours >= 6.0

    if inp.recovery_score < 50.0 or inp.back_to_back_heavy:
        return "red"
    if 50.0 <= inp.recovery_score <= 70.0 or heavy_day:
        return "yellow"
    return "green"


def protocol_for_tier(tier: str, wake_time: str) -> dict[str, str]:
    wake_h, wake_m = [int(x) for x in wake_time.split(":", 1)]
    wake_dt = datetime.combine(date.today(), time(wake_h, wake_m))

    if tier == "green":
        sleep_target = timedelta(hours=7, minutes=45)
        intensity = "Normal training is fine. Keep intensity planned."
    elif tier == "yellow":
        sleep_target = timedelta(hours=8, minutes=15)
        intensity = "Reduce intensity 10-20%. Prefer moderate/session quality over volume."
    else:
        sleep_target = timedelta(hours=8, minutes=45)
        intensity = "Aggressive recovery mode: mobility/zone2 only, skip max-effort lifting."

    bedtime = wake_dt - sleep_target
    wind_down = bedtime - timedelta(minutes=90)
    screen_cutoff = bedtime - timedelta(minutes=60)

    return {
        "bedtime_target": bedtime.strftime("%I:%M %p"),
        "wind_down_start": wind_down.strftime("%I:%M %p"),
        "screen_cutoff": screen_cutoff.strftime("%I:%M %p"),
        "workout_adjustment": intensity,
    }


def build_inputs(target: date) -> SleepInputs:
    sleep_payload = fetch_whoop_sleep()
    strain_payload = fetch_strain()

    recovery, sleep_hours = parse_recovery_sleep_hours(sleep_payload)
    strain, back_to_back_heavy = parse_strain(strain_payload)
    events, booked_hours = fetch_calendar_load(target)

    return SleepInputs(
        recovery_score=round(recovery, 1),
        sleep_hours=round(sleep_hours, 2),
        strain=round(strain, 1),
        back_to_back_heavy=back_to_back_heavy,
        next_day_events=events,
        booked_hours=booked_hours,
        target_date=target.isoformat(),
    )


def insert_pattern(inp: SleepInputs, tier: str, protocol: dict[str, str]) -> None:
    metadata = {
        "target_date": inp.target_date,
        "recovery_score": inp.recovery_score,
        "sleep_hours": inp.sleep_hours,
        "strain": inp.strain,
        "back_to_back_heavy": inp.back_to_back_heavy,
        "next_day_events": inp.next_day_events,
        "booked_hours": inp.booked_hours,
        "protocol": protocol,
    }

    sql = (
        "INSERT INTO cortana_patterns (pattern_type, value, day_of_week, metadata) "
        f"VALUES ('adaptive_sleep_protocol', '{sql_escape(tier)}', "
        "EXTRACT(DOW FROM NOW())::int, "
        f"'{sql_escape(json.dumps(metadata))}'::jsonb);"
    )
    run_psql_exec(sql)


def run_psql_exec(sql: str) -> None:
    env = os.environ.copy()
    env["PATH"] = f"/opt/homebrew/opt/postgresql@17/bin:{env.get('PATH', '')}"
    subprocess.run([PSQL_BIN, "cortana", "-X", "-v", "ON_ERROR_STOP=1", "-c", sql], capture_output=True, text=True, env=env)


def sql_escape(value: str) -> str:
    return (value or "").replace("'", "''")


def first_numeric(payload: dict[str, Any], paths: list[str], default: float = 0.0) -> float:
    for path in paths:
        v = get_path(payload, path)
        if isinstance(v, (int, float)):
            return float(v)
        if isinstance(v, str):
            try:
                return float(v)
            except ValueError:
                continue
    return default


def first_list(payload: dict[str, Any], paths: list[str]) -> list[Any]:
    for path in paths:
        v = get_path(payload, path)
        if isinstance(v, list):
            return v
    return []


def get_path(payload: Any, path: str) -> Any:
    cur = payload
    for part in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(part)
    return cur


def format_telegram(inp: SleepInputs, tier: str, protocol: dict[str, str]) -> str:
    tier_emoji = {"green": "🟢", "yellow": "🟡", "red": "🔴"}[tier]
    return "\n".join(
        [
            f"{tier_emoji} Adaptive Sleep Protocol — {inp.target_date}",
            f"Recovery: {inp.recovery_score:.0f}% | Sleep: {inp.sleep_hours:.2f}h | Strain: {inp.strain:.1f}",
            f"Calendar load: {inp.next_day_events} events / {inp.booked_hours:.1f}h",
            f"Tier: {tier.upper()}",
            "",
            f"🛏️ Bedtime target: {protocol['bedtime_target']}",
            f"🌙 Wind-down start: {protocol['wind_down_start']}",
            f"📵 Screen cutoff: {protocol['screen_cutoff']}",
            f"🏋️ Workout adjustment: {protocol['workout_adjustment']}",
        ]
    )


def main() -> int:
    args = parse_args()
    target = get_target_date(args.date)

    try:
        inputs = build_inputs(target)
    except Exception as exc:
        print(f"adaptive_sleep failed: {exc}", file=sys.stderr)
        return 1

    tier = classify_tier(inputs)
    protocol = protocol_for_tier(tier, args.wake_time)

    if not args.dry_run:
        insert_pattern(inputs, tier, protocol)

    payload = {
        "date": inputs.target_date,
        "tier": tier,
        "inputs": inputs.__dict__,
        "protocol": protocol,
        "telegram": format_telegram(inputs, tier, protocol),
    }

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(payload["telegram"])

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
