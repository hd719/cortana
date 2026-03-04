#!/usr/bin/env npx tsx
import { spawnSync } from "child_process";

const script = String.raw`# Doc Gardener
#
# Weekly documentation hygiene sweep for the openclaw repo.
# Intended to be run by a Librarian-style agent or manually.
#
# Responsibilities:
# - Scan MEMORY.md for:
#   * Possible duplicate lines
#   * Potential contradictions (very coarse heuristics)
#   * Stale dated entries (dates >30 days old)
# - Scan TOOLS.md for likely-outdated entries (paths that no longer exist)
# - Identify orphaned docs in docs/ not referenced by AGENTS.md or MEMORY.md
# - Emit a human-readable report to stdout with file:line references
# - Optional: with --auto-fix, apply conservative annotations and auto-commit
#
# Design goals:
# - Pure bash + standard tools (grep, awk, sed, python if available for date math)
# - Handle missing files gracefully
# - Never crash just because one check fails
# - Auto-fix is intentionally conservative and opt-in

set -euo pipefail

AUTO_FIX=0
while [[ "\${1-}" != "" ]]; do
  case "$1" in
    --auto-fix)
      AUTO_FIX=1
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Doc Gardener - documentation hygiene sweep

Usage:
  tools/doc-gardener/doc-gardener.sh [--auto-fix]

Without flags, prints a report to stdout only.
With --auto-fix, tries to:
  - Annotate broken paths in TOOLS.md with a "(BROKEN?)" marker
  - Append an "Orphan docs" section to docs/system-hygiene-sweep.md
  - Commit those changes if the git working tree was clean before the run
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Resolve repo root (assume script lives in tools/doc-gardener/)
SCRIPT_DIR=$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
cd "$REPO_ROOT"

MEMORY_FILE="$REPO_ROOT/MEMORY.md"
TOOLS_FILE="$REPO_ROOT/TOOLS.md"
AGENTS_FILE="$REPO_ROOT/AGENTS.md"
DOCS_DIR="$REPO_ROOT/docs"
HYGIENE_DOC="$DOCS_DIR/system-hygiene-sweep.md"

NOW_ISO=$(date +%Y-%m-%dT%H:%M:%S%z)
TODAY=$(date +%Y-%m-%d)

# Helper: safe existence check for paths in TOOLS.md
expand_path() {
  local raw="$1"
  # Strip surrounding backticks if present
  raw=\${raw#\`}
  raw=\${raw%\`}
  # Expand ~ and normalize repo-relative paths
  case "$raw" in
    ~/*)
      printf '%s\n' "/Users/hd/\${raw#~/}"
      ;;
    ./*)
      printf '%s\n' "$REPO_ROOT/\${raw#./}"
      ;;
    */openclaw/*)
      # Already absolute or includes openclaw path
      printf '%s\n' "$raw"
      ;;
    tools/*|docs/*|skills/*)
      printf '%s\n' "$REPO_ROOT/$raw"
      ;;
    *)
      printf '%s\n' "$raw"
      ;;
  esac
}

# Record initial git cleanliness so we can decide whether to auto-commit
INITIAL_GIT_STATUS=""
if command -v git >/dev/null 2>&1; then
  INITIAL_GIT_STATUS=$(git status --porcelain || true)
fi

report_header() {
  echo "========================================"
  echo "Doc Gardener Report - $NOW_ISO"
  echo "Repo: $REPO_ROOT"
  echo "========================================"
  echo
}

section_header() {
  echo
  echo "----------------------------------------"
  echo "$1"
  echo "----------------------------------------"
}

# 1) MEMORY.md analysis
scan_memory() {
  section_header "MEMORY.md analysis"
  if [[ ! -f "$MEMORY_FILE" ]]; then
    echo "MEMORY.md not found at $MEMORY_FILE (skipping)."
    return
  fi

  echo "File: $MEMORY_FILE"

  # 1a) Duplicate lines (exact text duplicates, ignoring leading/trailing whitespace)
  echo
  echo "Potential duplicate lines (same content appears >1x):"
  awk '
    { gsub(/^ +| +$/, "", $0); line=$0; counts[line]++; lines[NR]=line }
    END {
      for (l in counts) if (counts[l] > 1 && length(l) > 0) {
        printf("  DUPLICATE x%d: %s\n", counts[l], l)
      }
    }
  ' "$MEMORY_FILE" | sed 's/^/  /' || echo "  (error running duplicate scan)"

  # 1b) Potential contradictions (very coarse heuristic)
  echo
  echo "Potential contradictions (heuristic, manual review required):"
  # Strategy: look for lines containing the same key phrase with BOTH "never" and "always"/"must".
  # We approximate key phrase as the part after the first dash or bullet.
  awk '
    NR==1{next}
    {
      line=$0
      lower=line
      for(i=1;i<=length(lower);i++){
        c=substr(lower,i,1); if(c>="A" && c<="Z") c=tolower(c); sub(substr(lower,i,1),c,lower)
      }
      key=line
      sub(/^[-*] +/, "", key)
      if (index(lower, "never")>0) {
        seenNever[key]=seenNever[key] ? seenNever[key]";"NR : NR
      }
      if (index(lower, "always")>0 || index(lower, "must")>0) {
        seenAlways[key]=seenAlways[key] ? seenAlways[key]";"NR : NR
      }
      lines[NR]=line
    }
    END {
      for (k in seenNever) {
        if (k in seenAlways) {
          printf("  KEY: %s\n", k)
          split(seenNever[k], a, ";")
          for(i in a) printf("    never@line %s\n", a[i])
          split(seenAlways[k], b, ";")
          for(i in b) printf("    always/must@line %s\n", b[i])
        }
      }
    }
  ' "$MEMORY_FILE" || echo "  (error running contradiction scan)"

  # 1c) Stale dated entries (>30 days old)
  echo
  echo "Stale date candidates (>30 days old, based on YYYY-MM-DD patterns):"
  if command -v python3 >/dev/null 2>&1; then
    # Extract unique YYYY-MM-DD tokens with line numbers, then filter via Python date math
    awk '
      {
        for (i=1; i<=NF; i++) {
          if ($i ~ /[0-9]{4}-[0-9]{2}-[0-9]{2}/) {
            printf("%d %s\n", NR, $i)
          }
        }
      }
    ' "$MEMORY_FILE" |
    python3 - "$TODAY" <<'PY'
import sys, datetime
from collections import defaultdict

today_str = sys.argv[1]
today = datetime.datetime.strptime(today_str, "%Y-%m-%d").date()

seen = defaultdict(lambda: {"lines": set()})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    lineno_str, date_str = line.split(maxsplit=1)
    try:
        d = datetime.datetime.strptime(date_str[:10], "%Y-%m-%d").date()
    except ValueError:
        continue
    age = (today - d).days
    if age > 30:
        info = seen[date_str[:10]]
        info["lines"].add(int(lineno_str))

if not seen:
    print("  (no stale dates found by heuristic)")
else:
    for d, info in sorted(seen.items()):
        lines = ",".join(str(x) for x in sorted(info["lines"]))
        print(f"  {d} (lines {lines})")
PY
  else
    echo "  python3 not available; skipping stale-date detection."
  fi
}

# 2) TOOLS.md scan for broken paths
scan_tools() {
  section_header "TOOLS.md scan"
  if [[ ! -f "$TOOLS_FILE" ]]; then
    echo "TOOLS.md not found at $TOOLS_FILE (skipping)."
    return
  fi

  echo "File: $TOOLS_FILE"
  echo
  echo "Paths that appear to be missing on disk:"  

  # Grep for backticked paths and anything containing /openclaw/
  awk '
    {
      match($0, /\`([^\`]+)\`/, m)
      if (m[1] != "") {
        print NR" "m[1]
      }
    }
  ' "$TOOLS_FILE" |
  while read -r lineno rawpath; do
    fullpath=$(expand_path "$rawpath")
    if [[ "$fullpath" == *"openclaw"* ]]; then
      if [[ ! -e "$fullpath" ]]; then
        printf "  line %s: %s (expanded: %s)\n" "$lineno" "$rawpath" "$fullpath"
      fi
    fi
  done
}

# 3) Orphaned docs
scan_orphan_docs() {
  section_header "Orphaned docs in docs/ (not referenced from AGENTS.md or MEMORY.md)"
  if [[ ! -d "$DOCS_DIR" ]]; then
    echo "docs/ directory not found at $DOCS_DIR (skipping)."
    return
  fi
  if [[ ! -f "$AGENTS_FILE" ]] || [[ ! -f "$MEMORY_FILE" ]]; then
    echo "AGENTS.md or MEMORY.md missing; cannot perform orphan-doc detection."
    return
  fi

  local orphan_count=0
  while IFS= read -r -d '' file; do
    rel=\${file#"$REPO_ROOT/"}
    base=$(basename "$file")
    name_without_ext=\${base%.*}

    if ! grep -q "$base" "$AGENTS_FILE" "$MEMORY_FILE" 2>/dev/null && \
       ! grep -q "$name_without_ext" "$AGENTS_FILE" "$MEMORY_FILE" 2>/dev/null; then
      echo "  orphan: $rel"
      orphan_count=$((orphan_count+1))
    fi
  done < <(find "$DOCS_DIR" -maxdepth 1 -type f -name '*.md' -print0)

  if [[ "$orphan_count" -eq 0 ]]; then
    echo "  (no obvious orphan docs detected at top level of docs/)"
  fi
}

apply_auto_fixes() {
  section_header "Auto-fix phase (--auto-fix)"

  if ! command -v git >/dev/null 2>&1; then
    echo "git not available; cannot perform auto-fix commits. Skipping."
    return
  fi

  local modified=0

  # 1) Annotate broken paths in TOOLS.md
  if [[ -f "$TOOLS_FILE" ]]; then
    echo "Annotating broken paths in TOOLS.md (if any)..."
    # Build a temp file with annotations added only once per path.
    tmp_tools=$(mktemp)
    awk -v repo_root="$REPO_ROOT" '
      function expand_path(raw,  r) {
        gsub("\`", "", raw)
        r = raw
        if (r ~ /^~\//) {
          sub(/^~\//, "/Users/hd/", r)
        } else if (r ~ /^\.\//) {
          sub(/^\.\//, repo_root"/", r)
        } else if (r ~ /^tools\// || r ~ /^docs\// || r ~ /^skills\//) {
          r = repo_root"/"r
        }
        return r
      }
      {
        line=$0
        annotated=0
        while (match(line, /\`([^\`]+)\`/, m)) {
          raw=m[1]
          full=expand_path(raw)
          if (full ~ /openclaw/ && system("[ -e "full" ]") != 0) {
            # Broken path candidate
            if (index(line, "BROKEN?") == 0) {
              sub("\`"raw"\`", "\`"raw"\` (BROKEN? doc-gardener "strftime("%Y-%m-%d")")", line)
            }
          }
          annotated=1
          # move past this backtick pair
          line=substr(line, RSTART+RLENGTH)
        }
        print $0
      }
    ' "$TOOLS_FILE" > "$tmp_tools" || true

    if [[ -s "$tmp_tools" ]]; then
      mv "$tmp_tools" "$TOOLS_FILE"
      modified=1
    else
      rm -f "$tmp_tools"
    fi
  fi

  # 2) Append orphan-docs note to system-hygiene-sweep.md
  if [[ -d "$DOCS_DIR" ]]; then
    mkdir -p "$DOCS_DIR"
    if [[ ! -f "$HYGIENE_DOC" ]]; then
      echo "Creating $HYGIENE_DOC with orphan-docs section."
      cat > "$HYGIENE_DOC" <<EOF
# System Hygiene Sweep

This doc tracks periodic hygiene tasks and findings.

## Orphan docs detected by doc-gardener

_Run: $NOW_ISO_

EOF
      modified=1
    fi

    echo "Appending orphan-doc list to $HYGIENE_DOC..."
    {
      echo
      echo "### Orphan docs snapshot - $NOW_ISO"
      local count=0
      while IFS= read -r -d '' file; do
        rel=\${file#"$REPO_ROOT/"}
        base=$(basename "$file")
        name_without_ext=\${base%.*}
        if ! grep -q "$base" "$AGENTS_FILE" "$MEMORY_FILE" 2>/dev/null && \
           ! grep -q "$name_without_ext" "$AGENTS_FILE" "$MEMORY_FILE" 2>/dev/null; then
          echo "- $rel"
          count=$((count+1))
        fi
      done < <(find "$DOCS_DIR" -maxdepth 1 -type f -name '*.md' -print0)
      if [[ "$count" -eq 0 ]]; then
        echo "- (no orphan docs detected at this run)"
      fi
    } >> "$HYGIENE_DOC"
    modified=1
  fi

  if [[ "$modified" -eq 0 ]]; then
    echo "No auto-fixable issues detected; nothing to change."
    return
  fi

  # 3) Commit changes if repo was clean before run
  if [[ -n "$INITIAL_GIT_STATUS" ]]; then
    echo "Git working tree was already dirty before doc-gardener; skipping auto-commit."
    echo "You can review and commit changes manually."
    return
  fi

  echo "Git working tree was clean before run; creating auto-fix commit."
  git add "$TOOLS_FILE" "$HYGIENE_DOC" 2>/dev/null || true
  if git diff --cached --quiet; then
    echo "No staged changes after auto-fix; nothing to commit."
    return
  fi

  git commit -m "chore: doc-gardener auto-fix ($TODAY)" >/dev/null 2>&1 || {
    echo "git commit failed; leaving changes unstaged for manual review." >&2
    return
  }

  echo "Auto-fix commit created."
}

main() {
  report_header
  scan_memory
  scan_tools
  scan_orphan_docs

  if [[ "$AUTO_FIX" -eq 1 ]]; then
    apply_auto_fixes
  else
    echo
    echo "(Run with --auto-fix for conservative annotations + optional auto-commit.)"
  fi
}

main "$@"
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const r = spawnSync("bash", ["-lc", script, "script", ...args], { encoding: "utf8" });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status ?? 1);
}

main();
