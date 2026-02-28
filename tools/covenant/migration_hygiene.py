#!/usr/bin/env python3
"""Migration hygiene checker for /Users/hd/openclaw/migrations.

Policy:
- Existing migrations are immutable (no renames/rewrites).
- Deterministic execution order is controlled by a manifest.
- Future migrations must use unique numeric prefixes.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

WORKSPACE_ROOT = Path("/Users/hd/openclaw")
MIGRATIONS_DIR = WORKSPACE_ROOT / "migrations"
MANIFEST_PATH = MIGRATIONS_DIR / "manifest.json"
MIGRATION_RE = re.compile(r"^(?P<prefix>\d{3})_(?P<slug>[a-z0-9_]+)\.sql$")


class HygieneError(Exception):
    pass


def _list_sql_files() -> list[str]:
    return sorted([p.name for p in MIGRATIONS_DIR.glob("*.sql")])


def _load_manifest() -> dict:
    if not MANIFEST_PATH.exists():
        raise HygieneError(f"Manifest missing: {MANIFEST_PATH}")
    try:
        data = json.loads(MANIFEST_PATH.read_text())
    except json.JSONDecodeError as exc:
        raise HygieneError(f"Invalid manifest JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise HygieneError("Manifest must be a JSON object")
    return data


def _normalize_list(value: object) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
        raise HygieneError("Manifest `order` must be an array of filenames")
    return list(value)


def _parse_prefix(name: str) -> str | None:
    m = MIGRATION_RE.match(name)
    return m.group("prefix") if m else None


def check_migrations() -> dict:
    files = _list_sql_files()
    manifest = _load_manifest()
    order = _normalize_list(manifest.get("order"))
    legacy_dup_allowed = set(manifest.get("legacy_duplicate_prefixes", []))

    file_set = set(files)
    order_set = set(order)

    missing_from_manifest = sorted(file_set - order_set)
    missing_from_disk = sorted(order_set - file_set)

    prefixes = [_parse_prefix(f) for f in files]
    invalid_names = [f for f, p in zip(files, prefixes) if p is None]

    dup_counts = Counter([p for p in prefixes if p is not None])
    duplicate_prefixes = sorted([p for p, c in dup_counts.items() if c > 1])

    unexpected_duplicates = sorted([p for p in duplicate_prefixes if p not in legacy_dup_allowed])

    max_prefix = max((int(p) for p in dup_counts.keys()), default=0)

    problems: list[str] = []
    if missing_from_manifest:
        problems.append(f"Files missing from manifest: {', '.join(missing_from_manifest)}")
    if missing_from_disk:
        problems.append(f"Manifest references missing files: {', '.join(missing_from_disk)}")
    if invalid_names:
        problems.append(f"Invalid filename format: {', '.join(invalid_names)}")
    if unexpected_duplicates:
        problems.append(
            "Unexpected duplicate prefixes (must be unique unless explicitly grandfathered): "
            + ", ".join(unexpected_duplicates)
        )

    status = "ok" if not problems else "error"
    return {
        "status": status,
        "migration_count": len(files),
        "max_prefix": max_prefix,
        "duplicate_prefixes": duplicate_prefixes,
        "legacy_duplicate_prefixes": sorted(legacy_dup_allowed),
        "problems": problems,
    }


def suggest_next_prefix() -> int:
    report = check_migrations()
    return int(report["max_prefix"]) + 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate migration hygiene manifest")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    parser.add_argument("--next-prefix", action="store_true", help="Print next legal unique numeric prefix")
    args = parser.parse_args()

    try:
        if args.next_prefix:
            print(f"{suggest_next_prefix():03d}")
            return 0

        report = check_migrations()
        if args.json:
            print(json.dumps(report, indent=2))
        else:
            print(f"status: {report['status']}")
            print(f"migration_count: {report['migration_count']}")
            print(f"max_prefix: {report['max_prefix']:03d}")
            print("duplicate_prefixes:", ", ".join(report["duplicate_prefixes"]) or "none")
            if report["problems"]:
                print("problems:")
                for p in report["problems"]:
                    print(f"- {p}")
            else:
                print("problems: none")
        return 0 if report["status"] == "ok" else 1
    except HygieneError as exc:
        if args.json:
            print(json.dumps({"status": "error", "problems": [str(exc)]}, indent=2))
        else:
            print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
