# Memory Compaction & Archival Policy

This policy keeps `MEMORY.md` and daily memory notes bounded, searchable, and reviewable.

## Scope

- `MEMORY.md` (long-term curated memory)
- `memory/YYYY-MM-DD.md` (daily logs)
- `memory/archive/YYYY/MM/YYYY-MM-DD.md` (archived daily logs)

## Rules

### 1) Daily note archival (7-day rule)

- Daily files matching `memory/YYYY-MM-DD.md` are archived once they are **older than 7 days**.
- Archived destination is deterministic by date:
  - `memory/archive/YYYY/MM/YYYY-MM-DD.md`
- No deletion is performed during compaction; files are moved only.

### 2) Duplicate and near-duplicate detection in `MEMORY.md`

Compaction scans bullet-style lines and flags:
- **Exact duplicates**: normalized bullet content appears multiple times.
- **Near duplicates**: high-similarity bullets (SequenceMatcher ratio >= 0.92).

Normalization used for exact matching:
- Lowercase
- Collapse whitespace
- Strip punctuation

Duplicates are reported for manual cleanup; no automatic edits are made.

### 3) Staleness pruning candidates (>90 days)

Compaction flags lines in `MEMORY.md` containing date references older than **90 days**.

Supported date formats:
- `YYYY-MM-DD`
- `MM/DD/YY` or `MM/DD/YYYY`
- `Month DD, YYYY`

Flagged entries are written to a pruning section in the compaction report for review. The script **does not auto-delete** stale items.

### 4) Size limits for `MEMORY.md`

- **Warning**: file size > 25 KB (25,600 bytes)
- **Alert**: file size > 30 KB (30,720 bytes)

Size status is included in reports and emitted to `cortana_events`.

## Reporting

Each run writes a report to:

- `reports/memory-compaction/compaction-YYYYMMDD-HHMMSS.md`

Report sections include:
- Archived files moved
- Duplicate / near-duplicate findings
- Staleness review candidates
- Current `MEMORY.md` size and threshold status

## Database logging

Every run logs to PostgreSQL table `cortana_events` with:
- `event_type = 'memory_compaction'`
- `source = 'compact-memory.sh'`
- `severity = info|warning|critical`
- `message` summarizing size status
- `metadata` containing counts and report path

Postgres binary path assumed:
- `/opt/homebrew/opt/postgresql@17/bin/psql`

Database:
- `cortana`

## Manual trigger

Run manually from repo root or any location:

```bash
~/clawd/tools/memory/compact-memory.sh
```

Optional environment overrides:

```bash
ARCHIVE_AFTER_DAYS=7 STALE_AFTER_DAYS=90 WARN_SIZE_BYTES=25600 ALERT_SIZE_BYTES=30720 ~/clawd/tools/memory/compact-memory.sh
```

## Heartbeat rotation integration

Include this command in heartbeat memory maintenance rotation (daily):

```bash
~/clawd/tools/memory/compact-memory.sh
```

Recommended cadence:
- 1x daily, ideally during low-activity / maintenance windows.
