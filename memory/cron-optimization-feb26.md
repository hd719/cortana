# Cron Optimization Audit — 2026-02-26

## Scope
Targeted cron jobs:
1) `a519512a-5fb8-459f-8780-31e53793c1d4` (Fitness Morning Brief)
2) `62772130-a454-42f9-8526-38dfdaa3eb05` (Proprioception: Efficiency Analyzer)
3) `f47d5170-112d-473c-9c4a-d51662688899` (Daily Upgrade Protocol)
4) `dad2a631-8af3-4a8a-aef4-d3450f2f44e0` (SAE Cross-Domain Reasoner)

Token/runtime evidence was taken from `openclaw cron runs --id <id> --limit 3`.

---

## 1) 🏋️ Fitness Morning Brief (`a519...c1d4`)

### Root cause
- Prompt had broken shell variable interpolation (e.g., `if [ -z "" ]`, `--arg today ""`, empty date filters), which forced noisy/misleading execution paths.
- Prompt was over-specified and duplicated data fetches (`whoop/data` called multiple times).
- Evidence:
  - Runtime: **145620 ms**
  - Input tokens: **41997**
  - Prior runs timing out at 60s.

### Changes made
- Replaced bloated prompt with compact instruction (prompt size **1526 → 380 chars**).
- Added precompute script: `~/openclaw/tools/fitness/morning-brief-data.sh`
  - Fetches Whoop/Tonal once
  - Filters strictly to today
  - Emits compact JSON only
- Cron now uses only script output; no extra API calls from prompt.
- Model changed: `gpt-5.1` → `gpt-5.2-codex`
- Timeout adjusted to 90s (from 120s) due reduced workload.

### Expected improvement
- Lower API overhead and context stuffing.
- Expected runtime drop from ~145s to **~20–45s**.
- Expected input token reduction **substantially** (likely 40%+ from payload+tool-output reduction).

---

## 2) 📈 Proprioception: Efficiency Analyzer (`6277...eb05`)

### Root cause
- Prompt asked model to do filesystem cost analytics + SQL + DB updates in one shot.
- Manual exploratory work in-prompt produced long runtimes and intermittent timeout.
- Evidence:
  - Runtime: **89442 ms** (and **120018 ms timeout** previous run)
  - Input tokens: **15386**

### Changes made
- Replaced prompt with compact workflow (size **925 → 450 chars**).
- Added precompute script: `~/openclaw/tools/monitoring/proprioception-metrics.sh`
  - Computes top cost crons from session files
  - Computes subagent 7d estimated cost
  - Computes brief engagement heuristic from available schema
  - Returns compact JSON
- Prompt now only updates `cortana_self_model` and reports anomalies.
- Model changed: `gpt-5.3-codex` → `gpt-5.2-codex`
- Timeout reduced to 75s.

### Expected improvement
- Heavy lifting moved out of model reasoning path.
- Expected runtime: **~10–30s** typical.
- Expected timeout risk near-zero unless local FS/DB stalls.

---

## 3) 🔧 Daily Upgrade Protocol (`f47d...8899`)

### Root cause
- Prompt was verbose/redundant and asked for too much narrative/meta framing.
- Evidence:
  - Timeout event at **180094 ms**
  - Current success still **45723 ms** with high output volume
  - Input tokens: **5063** / Output tokens: **3122**

### Changes made
- Compressed prompt from **2471 → 455 chars**.
- Kept core behavior only:
  - skip if already proposed today
  - git auto-commit
  - inspect yesterday + recent corrections
  - propose one concrete fix
  - log to file + DB
- Model changed to `gpt-5.2-codex`.
- Timeout reduced from 180s to 90s.

### Expected improvement
- Less model narration and fewer tokens.
- Expected runtime: **~20–35s**.
- Lower probability of runaway verbose output.

---

## 4) 🧠 SAE Cross-Domain Reasoner (`dad2...44e0`)

### Root cause
- Prompt delegated to a large markdown process that dumps large current/previous sitrep payloads and patterns into context.
- It also attempted direct Telegram messaging from isolated cron session, causing repeated delivery failures.
- Evidence:
  - Runtime: **67–74s**
  - Input tokens: **36234**, **64262**, **90674**
  - Repeated error: `⚠️ ✉️ Message failed`

### Changes made
- Replaced prompt with concise workflow (size **245 → 390 chars**, but dramatically less data loading behavior).
- Added precompute snapshot script: `~/openclaw/tools/sae/cross-domain-snapshot.sh`
  - Pulls current/previous sitrep JSON
  - Filters to key domains only
  - Caps keys/insight history for compactness
- Prompt now generates 0–3 insights and outputs only urgent lines.
- Disabled in-prompt Telegram call; switched job delivery to cron-native announce:
  - `delivery.mode: announce`
  - Telegram target configured
- Timeout reduced to 75s.

### Expected improvement
- Major input token collapse due compact snapshot.
- Expected runtime: **~20–40s**.
- Delivery failures from isolated-session messaging path should be eliminated (using cron delivery pipeline instead).

---

## Files changed
- `config/cron/jobs.json`
- `tools/fitness/morning-brief-data.sh` (new)
- `tools/monitoring/proprioception-metrics.sh` (new)
- `tools/sae/cross-domain-snapshot.sh` (new)

## Notes
- This is root-cause optimization (prompt simplification + precompute extraction + delivery path correction), not timeout inflation.
- No Mission Control rebuild required.
