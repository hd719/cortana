#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

pending_json="$(npx tsx "$SCRIPT_DIR/check-pending.ts" --json)"

read -r pending_count expired_count financial_count stale_count <<<"$(node -e '
  const data = JSON.parse(process.argv[1]);
  const pending = Array.isArray(data.pending) ? data.pending : [];
  const expired = pending.filter((p) => p.expired).length;
  const financial = pending.filter((p) => p.category === "financial").length;
  const stale = pending.filter((p) => (typeof p.age_hours === "number" ? p.age_hours : 0) >= 4).length;
  console.log([pending.length, expired, financial, stale].join(" "));
' "$pending_json")"

attention=0
flags=()
if (( expired_count > 0 )); then
  attention=1
  flags+=("URGENT")
fi
if (( financial_count > 0 )); then
  attention=1
  flags+=("HIGH PRIORITY")
fi
if (( stale_count > 0 )); then
  attention=1
  flags+=("STALE")
fi

commitments_section=""
if [[ -f "$REPO_ROOT/MEMORY.md" ]]; then
  commitments_section="$(awk '
    /^## Active Commitments/ {flag=1; next}
    /^## / {flag=0}
    flag {print}
  ' "$REPO_ROOT/MEMORY.md")"
fi

flags_label="${flags[*]:-NONE}"

printf "Pending decisions: %s (expired: %s, financial: %s, stale: %s)\n" "$pending_count" "$expired_count" "$financial_count" "$stale_count"
printf "Flags: %s\n" "$flags_label"

if [[ -n "$commitments_section" ]]; then
  printf "Active Commitments (MEMORY.md):\n%s\n" "$commitments_section"
else
  printf "Active Commitments (MEMORY.md): (none)\n"
fi

if (( attention > 0 )); then
  exit 1
fi

exit 0
