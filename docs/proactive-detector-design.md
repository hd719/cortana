# Proactive Opportunity Detector — Design

## Objective
Move heartbeat behavior from static rotation to confidence-gated anticipation. Detector identifies upcoming risks/opportunities *before* Hamel asks and writes structured outputs to DB for heartbeat surfacing.

## Inputs
- **Calendar**: gog calendar events (next 48h)
- **Portfolio**: Alpaca positions (`http://localhost:3033/alpaca/portfolio`) + Yahoo quote/summary market context
- **Email**: gog Gmail unread search (`is:unread newer_than:7d`)
- **Behavioral history**: `cortana_patterns`
- **Task context**: existing tasks/suggestions tables for de-dup and action tracking

## Signal Model
Each detection emits one normalized signal:
- `source` (`calendar|portfolio|email|behavior|cross_signal`)
- `signal_type` (e.g., `earnings_within_48h`)
- `title`, `summary`
- `confidence` (0-1)
- `severity` (`low|medium|high|critical`)
- `opportunity` (bool; false = risk)
- `starts_at` (optional future anchor)
- `fingerprint` (dedupe key)
- `metadata` (raw evidence)

Confidence is heuristic + evidence weighted (time proximity, anomaly magnitude, keyword certainty, cross-signal overlap size).

## Detection Modules

### 1) Calendar Intelligence
- **Prep needed**: keyworded high-stakes events in <=3h
- **Conflict/tight transitions**: <10m between events or overlap
- **Travel buffer**: location-bearing event within 2h

### 2) Portfolio Signals
- **Earnings <=48h** on held symbols
- **Unusual volume**: `regularMarketVolume / averageDailyVolume3Month >= 1.8x`
- **Sector rotation**: held sector underperforming top sector ETF by >=1.2% (proxy)

### 3) Email Patterning
- **Urgent thread**: urgency phrase detection
- **Follow-up needed**: “follow up / checking in / reminder” patterns
- **Unanswered backlog**: stale unread cluster (>30h)

### 4) Behavioral Prediction
- Uses `cortana_patterns` by weekday and recent frequency to predict routine windows (wake/sleep checks), yielding soft proactive prompts.

### 5) Cross-signal Correlation
- Token overlap between calendar signals and email signals.
- If overlap >=2 keywords, produce prep-risk correlation signal with confidence uplift.

## Confidence Gating
- Runtime gate `--min-confidence` (default `0.66`)
- Persist only gated signals
- Create tasks only for very high confidence (`>=0.82`, optional `--create-tasks`)

## Persistence
New tables:
- `cortana_proactive_detector_runs`: run telemetry, counts, errors
- `cortana_proactive_signals`: normalized, deduplicated proactive signal store

Existing table integration:
- `cortana_proactive_suggestions`: created for each gated signal
- `cortana_tasks`: optional high-confidence task creation

## Execution Path
Script: `tools/proactive/detect.py`

Examples:
```bash
# Preview only
python3 /Users/hd/Developer/cortana/tools/proactive/detect.py --dry-run

# Persist suggestions at default gate
python3 /Users/hd/Developer/cortana/tools/proactive/detect.py

# More selective + create actionable tasks for strongest signals
python3 /Users/hd/Developer/cortana/tools/proactive/detect.py --min-confidence 0.72 --create-tasks
```

## Heartbeat Integration
Add a proactive check to heartbeat rotation (2-3x daily):
```bash
python3 /Users/hd/Developer/cortana/tools/proactive/detect.py --min-confidence 0.66
```
Heartbeat should surface top 1-2 high confidence new signals and suppress noise.

## Failure Behavior
- Collector failures are isolated per source and recorded in run `errors` JSON.
- Detector still completes with partial data.
- No outbound actions; this is detect + suggest only.
