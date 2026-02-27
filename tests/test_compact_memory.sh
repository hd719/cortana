#!/usr/bin/env bash
set -euo pipefail

assert_true(){ "$@" || { echo "ASSERT FAILED: $*"; exit 1; }; }
assert_contains(){ [[ "$1" == *"$2"* ]] || { echo "ASSERT FAILED: expected '$2' in: $1"; exit 1; }; }

TMPROOT="$(mktemp -d)"
trap 'rm -rf "$TMPROOT"' EXIT
mkdir -p "$TMPROOT/tools/memory" "$TMPROOT/memory" "$TMPROOT/reports"
cp /Users/hd/clawd/tools/memory/compact-memory.sh "$TMPROOT/tools/memory/compact-memory.sh"
chmod +x "$TMPROOT/tools/memory/compact-memory.sh"

python3 - <<'PY' "$TMPROOT"
from datetime import date,timedelta
from pathlib import Path
root=Path(__import__('sys').argv[1])
(root/'memory'/'MEMORY.md').write_text('placeholder')
(root/'MEMORY.md').write_text('x'*26050)
old=(date.today()-timedelta(days=8)).isoformat()+'.md'
new=(date.today()-timedelta(days=2)).isoformat()+'.md'
(root/'memory'/old).write_text('old')
(root/'memory'/new).write_text('new')
PY

MOCK_PSQL="$TMPROOT/mock-psql"
cat > "$MOCK_PSQL" <<'PSQL'
#!/usr/bin/env bash
exit 0
PSQL
chmod +x "$MOCK_PSQL"

out1="$(DB_NAME=test PSQL_BIN="$MOCK_PSQL" bash "$TMPROOT/tools/memory/compact-memory.sh")"
old_name="$(python3 - <<'PY'
from datetime import date,timedelta
print((date.today()-timedelta(days=8)).isoformat()+'.md')
PY
)"
new_name="$(python3 - <<'PY'
from datetime import date,timedelta
print((date.today()-timedelta(days=2)).isoformat()+'.md')
PY
)"
assert_true test -f "$TMPROOT/memory/archive/${old_name:0:4}/${old_name:5:2}/$old_name"
assert_true test -f "$TMPROOT/memory/$new_name"
assert_contains "$out1" "(warning)"

python3 - <<'PY' "$TMPROOT/MEMORY.md"
from pathlib import Path
Path(__import__('sys').argv[1]).write_text('y'*31050)
PY
out2="$(DB_NAME=test PSQL_BIN="$MOCK_PSQL" bash "$TMPROOT/tools/memory/compact-memory.sh")"
assert_contains "$out2" "(alert)"

echo "PASS: compact-memory"
