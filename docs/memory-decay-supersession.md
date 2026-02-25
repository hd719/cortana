# Memory Freshness Decay + Supersession Chains

Task 132 implementation: decay-aware retrieval + supersession lineage with active filtering.

## 1) Decay scoring (`tools/memory/decay.py`)

Half-life by memory type:

- `fact`: 365 days
- `preference`: 180 days
- `event` / `episodic`: 14 days
- `system_rule` (`rule` alias): never decays

Formula used by retrieval:

- `relevance = (0.5 * similarity) + (0.3 * recency_score) + (0.2 * utility_score)`
- `recency_score = 2^(-(days_old / half_life))`
- `utility_score = log10(access_count + 1)`

Schema safeguards in `ensure_schema()`:

- `access_count INT NOT NULL DEFAULT 0`
- `supersedes_id BIGINT`
- `superseded_by BIGINT`
- `superseded_at TIMESTAMPTZ`

It also backfills `superseded_by` from existing `supersedes_id` links.

## 2) Supersession logic (`tools/memory/supersession.py`)

CLI commands:

```bash
python3 tools/memory/supersession.py chain <memory_id>
python3 tools/memory/supersession.py prune --max-depth 3
python3 tools/memory/supersession.py prune --max-depth 3 --dry-run
```

Behavior:

- `chain`: walks to oldest ancestor, then prints full lineage oldest → newest.
- `prune`: deactivates deeply superseded entries beyond max depth (`>3` by default).
  - superseded records remain in DB (audit trail preserved)
  - active retrieval still excludes them

## 3) Retrieval filtering + access tracking

`tools/covenant/memory_injector.py` now filters semantic memories with:

- `active = TRUE`
- `superseded_by IS NULL`
- `superseded_at IS NULL`

and increments `access_count` for semantic memories that are actually injected.

## 4) Migration

Added `migrations/018_memory_superseded_by.sql`:

- adds `superseded_by` + `access_count` if missing
- backfills supersession links
- adds FK + indexes for supersession lookups

## 5) Validation flow used

```bash
python3 tools/memory/decay.py stats
python3 tools/memory/supersession.py prune --max-depth 3 --dry-run
python3 tools/memory/supersession.py chain <sample_id>
python3 tools/covenant/memory_injector.py inject huragok --limit 3
```

Expected outcomes:

- decay scores include recency + utility terms
- superseded memories are absent from default retrieval
- `chain` returns lineage including superseded records
- retrieval increments `access_count`
