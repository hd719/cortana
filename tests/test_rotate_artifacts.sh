#!/usr/bin/env bash
set -euo pipefail
assert_true(){ "$@" || { echo "ASSERT FAILED: $*"; exit 1; }; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/tools/cron" "$TMP/run" "$TMP/mockbin"
cp /Users/hd/openclaw/tools/cron/rotate-cron-artifacts.sh "$TMP/tools/cron/"
chmod +x "$TMP/tools/cron/rotate-cron-artifacts.sh"

cat > "$TMP/mockbin/psql" <<'PSQL'
#!/usr/bin/env bash
exit 0
PSQL
chmod +x "$TMP/mockbin/psql"

python3 - <<'PY' "$TMP/run"
from pathlib import Path
p=Path(__import__('sys').argv[1])/'a.jsonl'
p.write_bytes(b'x'*(520*1024))
for i in range(5):
  (Path(__import__('sys').argv[1])/f'a.jsonl.2025010101010{i}.gz').write_bytes(b'g')
old=(Path(__import__('sys').argv[1])/'old.jsonl.20240101010101.gz')
old.write_bytes(b'o')
import os,time
old_ts=time.time()-9*24*3600
os.utime(old,(old_ts,old_ts))
PY

PATH="$TMP/mockbin:$PATH" OPENCLAW_CRON_RUN_DIR="$TMP/run" bash "$TMP/tools/cron/rotate-cron-artifacts.sh" >/tmp/rotate.out

assert_true test -f "$TMP/run/a.jsonl"
assert_true test $(stat -f%z "$TMP/run/a.jsonl") -eq 0
count=$(find "$TMP/run" -maxdepth 1 -name 'a.jsonl.*.gz' | wc -l | tr -d ' ')
assert_true test "$count" -le 3
assert_true test ! -f "$TMP/run/old.jsonl.20240101010101.gz"

echo "PASS: rotate-artifacts"
