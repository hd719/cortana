#!/usr/bin/env python3
"""Enforce Covenant memory boundaries for sub-agent write targets.

Usage:
  python3 tools/covenant/validate_memory_boundary.py <agent_identity_id> <target_path>
"""

from __future__ import annotations

import sys
from pathlib import Path

WORKSPACE_ROOT = Path("/Users/hd/openclaw").resolve()
LONG_TERM_MEMORY_FILES = {
    (WORKSPACE_ROOT / "MEMORY.md").resolve(),
}
LONG_TERM_MEMORY_PREFIXES = [
    (WORKSPACE_ROOT / "memory").resolve(),
]


def fail(msg: str) -> None:
    print(f"MEMORY_BOUNDARY_VIOLATION: {msg}", file=sys.stderr)
    raise SystemExit(1)


def in_dir(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: validate_memory_boundary.py <agent_identity_id> <target_path>", file=sys.stderr)
        raise SystemExit(2)

    agent_identity_id = sys.argv[1].strip()
    if not agent_identity_id:
        fail("agent_identity_id is required")

    target = Path(sys.argv[2]).expanduser().resolve()

    if not in_dir(target, WORKSPACE_ROOT):
        fail(f"path is outside workspace root: {target}")

    if target in LONG_TERM_MEMORY_FILES:
        fail(f"writes to long-term memory are restricted to Cortana main: {target}")

    for prefix in LONG_TERM_MEMORY_PREFIXES:
        if in_dir(target, prefix):
            fail(f"writes to long-term memory namespace are restricted to Cortana main: {target}")

    own_scratch = (WORKSPACE_ROOT / ".covenant" / "agents" / agent_identity_id / "scratch").resolve()
    any_scratch_root = (WORKSPACE_ROOT / ".covenant" / "agents").resolve()

    if in_dir(target, any_scratch_root) and not in_dir(target, own_scratch):
        fail(
            "cross-agent scratch access denied: "
            f"{target} is not under {own_scratch}"
        )

    # Guardrail for direct writes into covenant identity docs.
    identities_root = (WORKSPACE_ROOT / "agents" / "identities").resolve()
    if in_dir(target, identities_root):
        fail("agent identity contracts are immutable during task execution")

    print("MEMORY_BOUNDARY_OK")


if __name__ == "__main__":
    main()
