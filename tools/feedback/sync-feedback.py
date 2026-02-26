#!/usr/bin/env python3
import csv
import io
import json
import re
import subprocess
import uuid
from typing import Dict, List, Set

DB = "cortana"
PSQL = ["psql", DB, "-v", "ON_ERROR_STOP=1"]


def run_psql_csv(query: str) -> List[Dict[str, str]]:
    cmd = PSQL + ["-c", f"COPY ({query}) TO STDOUT WITH CSV HEADER"]
    out = subprocess.check_output(cmd, text=True)
    return list(csv.DictReader(io.StringIO(out)))


def run_sql(sql: str) -> None:
    subprocess.run(PSQL, input=sql, text=True, check=True)


def q(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def normalize_recurrence(lesson: str) -> str:
    if not lesson:
        return ""
    s = lesson.lower().strip()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"[^a-z0-9 ]", "", s)
    return s[:50].strip()


def map_row(row: Dict[str, str]):
    ftype = (row.get("feedback_type") or "").strip().lower()
    lesson = row.get("lesson") or ""

    if ftype == "correction":
        category = "correction"
        severity = "high" if re.search(r"HARD RULE|MANDATORY|ZERO TOLERANCE", lesson, re.IGNORECASE) else "medium"
    elif ftype == "preference":
        category = "preference"
        severity = "low"
    elif ftype == "approval":
        category = "policy"
        severity = "low"
    elif ftype == "rejection":
        category = "policy"
        severity = "medium"
    else:
        return None

    context = row.get("context") or ""
    applied = (row.get("applied") or "").strip().lower() in {"t", "true", "1"}

    return {
        "id": str(uuid.uuid4()),
        "source": "user",
        "category": category,
        "severity": severity,
        "summary": context[:200],
        "details": json.dumps({"context": context, "lesson": lesson}, ensure_ascii=False),
        "recurrence_key": normalize_recurrence(lesson),
        "status": "verified" if applied else "new",
        "applied": applied,
        "lesson": lesson,
    }


def main():
    feedback_rows = run_psql_csv(
        "SELECT id, feedback_type, context, lesson, applied, timestamp FROM cortana_feedback ORDER BY id"
    )

    existing_keys_rows = run_psql_csv(
        "SELECT recurrence_key FROM mc_feedback_items WHERE recurrence_key IS NOT NULL"
    )
    existing_keys: Set[str] = {
        (r.get("recurrence_key") or "").strip() for r in existing_keys_rows if (r.get("recurrence_key") or "").strip()
    }

    seen_new_keys: Set[str] = set()
    inserts = 0
    skipped_dupe = 0
    skipped_unmapped = 0
    actions = 0

    sql_lines = ["BEGIN;"]

    for r in feedback_rows:
        mapped = map_row(r)
        if not mapped:
            skipped_unmapped += 1
            continue

        rk = mapped["recurrence_key"]
        if rk and (rk in existing_keys or rk in seen_new_keys):
            skipped_dupe += 1
            continue

        sql_lines.append(
            "INSERT INTO mc_feedback_items (id, source, category, severity, summary, details, recurrence_key, status) "
            f"VALUES ({q(mapped['id'])}::uuid, {q(mapped['source'])}, {q(mapped['category'])}, {q(mapped['severity'])}, "
            f"{q(mapped['summary'])}, {q(mapped['details'])}::jsonb, {q(rk)}, {q(mapped['status'])});"
        )
        inserts += 1
        if rk:
            seen_new_keys.add(rk)

        if mapped["applied"]:
            sql_lines.append(
                "INSERT INTO mc_feedback_actions (feedback_id, action_type, description, status) "
                f"VALUES ({q(mapped['id'])}::uuid, 'policy_rule', {q(mapped['lesson'])}, 'verified');"
            )
            actions += 1

    sql_lines.append("COMMIT;")
    run_sql("\n".join(sql_lines))

    print("Feedback migration complete")
    print(f"- Source rows read: {len(feedback_rows)}")
    print(f"- Items inserted: {inserts}")
    print(f"- Actions inserted: {actions}")
    print(f"- Skipped duplicates (recurrence_key): {skipped_dupe}")
    print(f"- Skipped unmapped feedback_type: {skipped_unmapped}")


if __name__ == "__main__":
    main()
