#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MEMORY_DIR="$ROOT_DIR/memory"
MEMORY_FILE="$ROOT_DIR/MEMORY.md"
ARCHIVE_ROOT="$MEMORY_DIR/archive"
REPORT_DIR="$ROOT_DIR/reports/memory-compaction"

DB_NAME="${DB_NAME:-cortana}"
PSQL_BIN="${PSQL_BIN:-/opt/homebrew/opt/postgresql@17/bin/psql}"

ARCHIVE_AFTER_DAYS="${ARCHIVE_AFTER_DAYS:-7}"
STALE_AFTER_DAYS="${STALE_AFTER_DAYS:-90}"
WARN_SIZE_BYTES="${WARN_SIZE_BYTES:-25600}"   # 25 KB
ALERT_SIZE_BYTES="${ALERT_SIZE_BYTES:-30720}"  # 30 KB

mkdir -p "$ARCHIVE_ROOT" "$REPORT_DIR"

RUN_TS="$(date '+%Y-%m-%d %H:%M:%S %Z')"
RUN_ID="$(date '+%Y%m%d-%H%M%S')"
REPORT_FILE="$REPORT_DIR/compaction-$RUN_ID.md"

if [[ ! -f "$MEMORY_FILE" ]]; then
  echo "ERROR: MEMORY.md not found at $MEMORY_FILE" >&2
  exit 1
fi

ARCHIVE_LIST_FILE="$(mktemp)"
DEDUP_JSON_FILE="$(mktemp)"
STALE_JSON_FILE="$(mktemp)"
trap 'rm -f "$ARCHIVE_LIST_FILE" "$DEDUP_JSON_FILE" "$STALE_JSON_FILE"' EXIT

python3 - "$MEMORY_DIR" "$ARCHIVE_AFTER_DAYS" > "$ARCHIVE_LIST_FILE" <<'PY'
import os
import re
import sys
from datetime import date, timedelta

memory_dir = sys.argv[1]
archive_after = int(sys.argv[2])
cutoff = date.today() - timedelta(days=archive_after)
pat = re.compile(r'^(\d{4})-(\d{2})-(\d{2})\.md$')

for name in sorted(os.listdir(memory_dir)):
    full = os.path.join(memory_dir, name)
    if not os.path.isfile(full):
        continue
    m = pat.match(name)
    if not m:
        continue
    y, mth, d = map(int, m.groups())
    try:
        dt = date(y, mth, d)
    except ValueError:
        continue
    if dt < cutoff:
        print(full)
PY

archived_count=0
while IFS= read -r src; do
  [[ -z "$src" ]] && continue
  base="$(basename "$src")"
  year="${base:0:4}"
  month="${base:5:2}"
  target_dir="$ARCHIVE_ROOT/$year/$month"
  mkdir -p "$target_dir"
  mv "$src" "$target_dir/$base"
  archived_count=$((archived_count + 1))
done < "$ARCHIVE_LIST_FILE"

python3 - "$MEMORY_FILE" "$DEDUP_JSON_FILE" <<'PY'
import json
import re
import sys
import difflib
from collections import defaultdict

memory_file, out_path = sys.argv[1], sys.argv[2]
bullet_re = re.compile(r'^\s*(?:[-*+]|\d+\.)\s+(.+?)\s*$')

rows = []
with open(memory_file, 'r', encoding='utf-8') as f:
    for i, line in enumerate(f, start=1):
        m = bullet_re.match(line)
        if not m:
            continue
        raw = m.group(1)
        norm = re.sub(r'[^a-z0-9\s]', '', raw.lower())
        norm = re.sub(r'\s+', ' ', norm).strip()
        if not norm:
            continue
        rows.append({'line': i, 'raw': raw, 'norm': norm})

exact = defaultdict(list)
for r in rows:
    exact[r['norm']].append(r)

exact_dups = []
for k, vals in exact.items():
    if len(vals) > 1:
        exact_dups.append({'normalized': k, 'occurrences': vals})

near = []
seen_pairs = set()
for i in range(len(rows)):
    for j in range(i + 1, len(rows)):
        a, b = rows[i], rows[j]
        if a['norm'] == b['norm']:
            continue
        if abs(len(a['norm']) - len(b['norm'])) > 20:
            continue
        score = difflib.SequenceMatcher(None, a['norm'], b['norm']).ratio()
        if score >= 0.92:
            key = tuple(sorted((a['line'], b['line'])))
            if key in seen_pairs:
                continue
            seen_pairs.add(key)
            near.append({
                'score': round(score, 3),
                'a': {'line': a['line'], 'text': a['raw']},
                'b': {'line': b['line'], 'text': b['raw']},
            })

payload = {
    'bullet_count': len(rows),
    'exact_duplicate_groups': exact_dups,
    'near_duplicates': sorted(near, key=lambda x: x['score'], reverse=True),
}
with open(out_path, 'w', encoding='utf-8') as out:
    json.dump(payload, out, ensure_ascii=False, indent=2)
PY

python3 - "$MEMORY_FILE" "$STALE_AFTER_DAYS" "$STALE_JSON_FILE" <<'PY'
import json
import re
import sys
from datetime import date, datetime, timedelta

memory_file = sys.argv[1]
stale_after = int(sys.argv[2])
out_path = sys.argv[3]
cutoff = date.today() - timedelta(days=stale_after)

iso_pat = re.compile(r'\b(\d{4}-\d{2}-\d{2})\b')
us_pat = re.compile(r'\b(\d{1,2}/\d{1,2}/\d{2,4})\b')
month_pat = re.compile(r'\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})\b', re.IGNORECASE)

flags = []

with open(memory_file, 'r', encoding='utf-8') as f:
    for line_no, line in enumerate(f, start=1):
        candidates = []
        for m in iso_pat.finditer(line):
            try:
                d = datetime.strptime(m.group(1), '%Y-%m-%d').date()
                candidates.append((m.group(1), d))
            except ValueError:
                pass
        for m in us_pat.finditer(line):
            raw = m.group(1)
            fmt = '%m/%d/%Y' if len(raw.split('/')[-1]) == 4 else '%m/%d/%y'
            try:
                d = datetime.strptime(raw, fmt).date()
                candidates.append((raw, d))
            except ValueError:
                pass
        for m in month_pat.finditer(line):
            raw = m.group(0)
            try:
                d = datetime.strptime(raw, '%B %d, %Y').date()
                candidates.append((raw, d))
            except ValueError:
                try:
                    d = datetime.strptime(raw, '%b %d, %Y').date()
                    candidates.append((raw, d))
                except ValueError:
                    pass

        for raw, d in candidates:
            if d < cutoff:
                age_days = (date.today() - d).days
                flags.append({
                    'line': line_no,
                    'date': raw,
                    'parsed_date': d.isoformat(),
                    'age_days': age_days,
                    'line_text': line.strip(),
                })

with open(out_path, 'w', encoding='utf-8') as out:
    json.dump({'cutoff_days': stale_after, 'flags': flags}, out, ensure_ascii=False, indent=2)
PY

memory_size_bytes="$(wc -c < "$MEMORY_FILE" | tr -d ' ')"
size_status="ok"
size_message="MEMORY.md size within threshold"
if (( memory_size_bytes > ALERT_SIZE_BYTES )); then
  size_status="alert"
  size_message="MEMORY.md exceeds alert threshold (${ALERT_SIZE_BYTES} bytes)"
elif (( memory_size_bytes > WARN_SIZE_BYTES )); then
  size_status="warning"
  size_message="MEMORY.md exceeds warning threshold (${WARN_SIZE_BYTES} bytes)"
fi

dedup_exact_count="$(python3 -c "import json; d=json.load(open('$DEDUP_JSON_FILE')); print(len(d.get('exact_duplicate_groups', [])))")"
dedup_near_count="$(python3 -c "import json; d=json.load(open('$DEDUP_JSON_FILE')); print(len(d.get('near_duplicates', [])))")"
stale_count="$(python3 -c "import json; d=json.load(open('$STALE_JSON_FILE')); print(len(d.get('flags', [])))")"

{
  echo "# Memory Compaction Report"
  echo
  echo "- Run: $RUN_TS"
  echo "- Archived daily notes: $archived_count"
  echo "- Exact duplicate groups in MEMORY.md: $dedup_exact_count"
  echo "- Near-duplicate bullet pairs in MEMORY.md: $dedup_near_count"
  echo "- Stale date references (> $STALE_AFTER_DAYS days): $stale_count"
  echo "- MEMORY.md size: $memory_size_bytes bytes ($size_status)"
  echo
  echo "## Archived Files"
  if (( archived_count == 0 )); then
    echo "- None"
  else
    while IFS= read -r f; do
      [[ -n "$f" ]] && echo "- $f"
    done < "$ARCHIVE_LIST_FILE"
  fi
  echo
  echo "## Duplicate / Near-Duplicate Findings"
  python3 - "$DEDUP_JSON_FILE" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
exact = data.get('exact_duplicate_groups', [])
near = data.get('near_duplicates', [])

if not exact and not near:
    print('- No duplicate bullets detected.')
    raise SystemExit(0)

if exact:
    print('### Exact duplicate groups')
    for g in exact:
        occ = g.get('occurrences', [])
        lines = ', '.join(str(x['line']) for x in occ)
        sample = occ[0]['raw'] if occ else g.get('normalized', '')
        print(f"- Lines [{lines}] → {sample}")

if near:
    print('\n### Near-duplicate pairs (similarity >= 0.92)')
    for pair in near:
        a = pair['a']; b = pair['b']
        print(f"- score={pair['score']}: L{a['line']} '{a['text']}' ~ L{b['line']} '{b['text']}'")
PY
  echo
  echo "## Staleness Review Candidates"
  python3 - "$STALE_JSON_FILE" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
flags = data.get('flags', [])
if not flags:
    print('- No stale date references found.')
else:
    for item in flags:
        print(f"- L{item['line']} [{item['date']} | {item['age_days']} days old] {item['line_text']}")
PY
} > "$REPORT_FILE"

severity="info"
if [[ "$size_status" == "warning" || "$size_status" == "alert" || "$dedup_exact_count" -gt 0 || "$dedup_near_count" -gt 0 || "$stale_count" -gt 0 ]]; then
  severity="warning"
fi
if [[ "$size_status" == "alert" ]]; then
  severity="critical"
fi

metadata_json="$(python3 - <<PY
import json
print(json.dumps({
  "archived_count": int("$archived_count"),
  "dedup_exact_groups": int("$dedup_exact_count"),
  "dedup_near_pairs": int("$dedup_near_count"),
  "stale_count": int("$stale_count"),
  "memory_size_bytes": int("$memory_size_bytes"),
  "size_status": "$size_status",
  "archive_after_days": int("$ARCHIVE_AFTER_DAYS"),
  "stale_after_days": int("$STALE_AFTER_DAYS"),
  "report_file": "$REPORT_FILE"
}, separators=(",", ":")))
PY
)"

if [[ -x "$PSQL_BIN" ]]; then
  "$PSQL_BIN" "$DB_NAME" -v ON_ERROR_STOP=0 -c "INSERT INTO cortana_events (event_type, source, severity, message, metadata) VALUES ('memory_compaction', 'compact-memory.sh', '$severity', '$size_message', \$\$$metadata_json\$\$::jsonb);" >/dev/null 2>&1 || true
fi

echo "Memory compaction complete"
echo "- Archived files: $archived_count"
echo "- Duplicate groups: $dedup_exact_count"
echo "- Near-duplicate pairs: $dedup_near_count"
echo "- Stale candidates: $stale_count"
echo "- MEMORY.md size: $memory_size_bytes bytes ($size_status)"
echo "- Report: $REPORT_FILE"
