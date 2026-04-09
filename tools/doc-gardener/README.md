# Doc Gardener

Weekly documentation hygiene sweep for the `clawd` repo.

This tool is designed for the **Librarian** agent (or a human maintainer) to run on a schedule and keep long-lived docs healthy.

## What It Does

`doc-gardener.sh` performs three main checks and prints a report to stdout:

1. **MEMORY.md analysis**
   - Finds **exact duplicate lines** (same text appearing multiple times)
   - Flags **potential contradictions** using a simple heuristic:
     - Looks for rules that share the same key text but mix `never` with `always`/`must`
     - Marks them as *potential* conflicts for human review
   - Identifies **stale date candidates**:
     - Scans for `YYYY-MM-DD` tokens in `MEMORY.md`
     - Uses date math (via `python3` if available) to flag any dates **older than 30 days**

2. **TOOLS.md scan**
   - Extracts paths mentioned in backticks (`` `...` ``)
   - Expands `~/`, repo-relative paths (`tools/...`, `docs/...`, `skills/...`, `./...`)
   - Flags any path under `clawd` that does **not exist on disk** as a likely outdated entry

3. **Orphaned docs in `docs/`**
   - Looks at top-level `docs/*.md` files
   - Marks any file whose **basename** or **name-without-extension** does **not** appear in either:
     - `AGENTS.md`, or
     - `MEMORY.md`
   - These are reported as **orphan docs** for human triage

All checks are best-effort and fail-soft: if a file is missing or a tool is unavailable, the script notes it and continues.

## Usage

From the repo root (`~/Developer/cortana`):

```bash
# Dry run: report only
./tools/doc-gardener/doc-gardener.sh

# Enable conservative auto-fixes + auto-commit (if repo is clean)
./tools/doc-gardener/doc-gardener.sh --auto-fix
```

### Flags

- `--auto-fix`
  - Annotates broken paths in `TOOLS.md` with a `"(BROKEN? doc-gardener YYYY-MM-DD)"` marker next to the path
  - Appends an **orphan docs snapshot** section to `docs/archive/runbook/system-hygiene-sweep.md` listing currently-unreferenced docs
  - If the git working tree was **clean before the run**, stages those files and creates a commit:
    - `"chore: doc-gardener auto-fix (YYYY-MM-DD)"`
  - If the working tree was **already dirty**, it still applies the file edits but **skips the commit**, leaving changes for manual review

## Output

The script writes a plain-text report to stdout, structured as:

- Header with timestamp and repo path
- `MEMORY.md analysis` section
- `TOOLS.md scan` section
- `Orphaned docs` section
- Optional `Auto-fix phase` section when `--auto-fix` is used

Example (truncated):

```text
========================================
Doc Gardener Report - 2026-02-26T11:30:00-0500
Repo: /Users/hd/Developer/cortana
========================================

----------------------------------------
MEMORY.md analysis
----------------------------------------
File: /Users/hd/Developer/cortana/MEMORY.md

Potential duplicate lines (same content appears >1x):
  DUPLICATE x2: **No heart emojis** — We're Cortana/Chief, not a Hallmark card.

Potential contradictions (heuristic, manual review required):
  KEY: **Task delegation (HARD RULE)** — Main session is conversation + coordination ONLY.
    never@line 42
    always/must@line 57

Stale date candidates (>30 days old, based on YYYY-MM-DD patterns):
  2025-12-31 (lines 120, 133)
```

## Auto-Fix Behavior

Auto-fix is intentionally **conservative** and focuses on annotation rather than mutation of core narrative docs.

Specifically, when `--auto-fix` is enabled:

1. **TOOLS.md annotations**
   - Any backticked path under `clawd` that does not exist on disk is annotated in-place, once, with:
     - ` (BROKEN? doc-gardener YYYY-MM-DD)`
   - This makes it easy for a human (or Librarian agent) to search for `BROKEN?` and clean or update the entry.

2. **System hygiene doc**
   - `docs/archive/runbook/system-hygiene-sweep.md` is created if missing with a basic header
   - An `"Orphan docs snapshot - TIMESTAMP"` section is appended, containing:
     - A bullet list of orphaned docs detected in this run, or
     - A single `"(no orphan docs detected at this run)"` line

3. **Git commit policy**
   - If `git status --porcelain` was empty at the start of the run (clean tree):
     - `TOOLS.md` and `docs/archive/runbook/system-hygiene-sweep.md` are staged
     - A single commit is created: `"chore: doc-gardener auto-fix (YYYY-MM-DD)"`
   - If the tree was **not clean**, the script **does not commit**:
     - It prints a note and leaves edits unstaged or staged according to normal git behavior

This keeps automated commits scoped and predictable, while still allowing manual workflows.

## Cron Integration

`config/cron/jobs.json` contains the OpenClaw cron definitions. A dedicated weekly job should:

- Run on **Sunday evening** (ET)
- Use the **Librarian** role/model
- Execute the script from the repo root, e.g.:

```bash
cd /Users/hd/Developer/cortana && ./tools/doc-gardener/doc-gardener.sh
```

If/when you are comfortable with auto-fixes running unattended, the cron payload can be updated to include `--auto-fix`.

## Edge Cases & Notes

- If `MEMORY.md`, `TOOLS.md`, or `AGENTS.md` are missing, the script reports that and skips the relevant checks.
- If `python3` is not available, stale-date detection is skipped (with a note).
- Orphan detection currently only looks at **top-level** Markdown files in `docs/` (not nested directories) and matches on filename/basename.
- All heuristics are intentionally simple and biased toward **"flag for review"** rather than aggressive automatic edits.
