# Feedback Closure Verifier

`tools/reflection/feedback_verifier.py` audits whether feedback in `cortana_feedback` actually changed behavior.

## Why

Repeated correction on the same topic means the learning loop is broken.
This verifier checks both:

1. **Recurrence** — similar feedback appearing repeatedly
2. **Closure evidence** — whether MEMORY.md / AGENTS.md / SOUL.md contain keyword evidence of applied updates

---

## Commands

### 1) `audit`
Full audit with semantic grouping and per-entry closure checks.

```bash
python3 tools/reflection/feedback_verifier.py audit
```

Useful flags:

```bash
python3 tools/reflection/feedback_verifier.py audit \
  --window-days 30 \
  --similarity-threshold 0.82 \
  --repeat-threshold 2 \
  --output reports/feedback-closure-audit.json
```

### 2) `report`
Compact health summary.

```bash
python3 tools/reflection/feedback_verifier.py report --window-days 30
```

Outputs:
- Total feedback entries
- Unique vs repeated corrections
- Closure rate
- Count of broken-loop topics
- Top unclosed items

### 3) `alert`
Only critical unclosed loops for escalation.

```bash
python3 tools/reflection/feedback_verifier.py alert --window-days 30
```

A loop is considered **critical** when:
- cluster is a broken loop (`size > repeat_threshold`) and
- has significant unclosed evidence (`unclosed_entries >= 2` or `closure_rate < 0.5`)

---

## How it works

### Semantic grouping
- Pulls rows from `cortana_feedback`
- Builds local embeddings via `tools/embeddings/embed.py`
- Clusters rows by cosine similarity

### Broken-loop detection
- Any semantic cluster with size `> repeat_threshold` is flagged as a broken loop.
- Default threshold is `2` (so 3+ similar corrections = broken loop).

### Closure detection
For each feedback row:
- Extract keywords from `context + lesson`
- Check keyword hits in:
  - `MEMORY.md`
  - `AGENTS.md`
  - `SOUL.md`
- Evaluate closure evidence against expected target file by feedback type:
  - preference/fact → MEMORY.md
  - behavior/correction → AGENTS.md
  - tone → SOUL.md

---

## Output shape

`audit` includes:
- settings used
- total/unique/repeated counts
- closure metrics
- per-cluster diagnostics
- `broken_loops`
- `top_unclosed_feedback_items`
- per-entry details (`entries`)

`report` is a concise subset for dashboards.

`alert` returns only critical loop payloads for human surfacing.

---

## Notes

- Requires local PostgreSQL access to `cortana`.
- Requires local embedding runtime (`fastembed`) through `tools/embeddings/embed.py`.
- Analyzer is evidence-based; keyword matches are a strong heuristic, not a perfect guarantee of behavioral change.
