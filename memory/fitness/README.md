# Fitness Tracking

This directory stores Hamel's daily fitness data from Whoop and Tonal.

## Structure
- `YYYY-MM-DD.json` - Daily fitness snapshots (morning + evening data)
- `weekly/` - Weekly summary reports
- `programs/json/current-tonal-catalog.json` - Generated observed Tonal workout/movement catalog built from live `http://localhost:3033/tonal/data` payloads via `tools/fitness/tonal-program-catalog.ts`, then persisted by `tools/fitness/tonal-plan-artifact.ts`
- `programs/md/current-tonal-catalog.md` - Human-readable summary companion for the observed Tonal workout/movement catalog
- `programs/json/tonal-public-movement-catalog.json` - Generated public Tonal movement library scrape with `pplBucket` and `metricReady`
- `programs/json/tonal-ppl-v1.json` - Curated Tonal-supported push/pull/legs split built from the public catalog plus your observed machine history
- `programs/md/` - Human-readable companions for the tracked Tonal planning artifacts

## Data Sources
- **Whoop**: Sleep, recovery, strain, HRV, workouts
- **Tonal**: Strength scores, workout details, volume, exercises

## Cron Schedule (ET)
- 7:00am - Morning brief (sleep/recovery + workout if done)
- 8:30pm - Evening recap (full day summary)
- Sunday 8pm - Weekly insights

## Service Endpoints
- `http://localhost:3033/whoop/data` - Whoop API (auto-refreshes tokens)
- `http://localhost:3033/tonal/data` - Tonal API (cached workout history)

## Flow
- `memory/fitness/programs/json/current-tonal-catalog.json` = your real observed Tonal history
- `memory/fitness/programs/json/tonal-public-movement-catalog.json` = Tonal's public movement library snapshot
- `memory/fitness/programs/json/tonal-ppl-v1.json` = curated PPL output built by combining the two
- `memory/fitness/programs/md/*.md` = human-readable companions for review and operator use

Practical flow:
- start with `current-tonal-catalog.json` to understand what you actually perform on Tonal
- use `tonal-public-movement-catalog.json` to confirm public Tonal support and bucket movements for planning
- curate `tonal-ppl-v1.json` from the overlap plus high-confidence observed-only movements that are clearly valid on your machine

## How `current-tonal-catalog.json` Is Generated
- Source payload: `http://localhost:3033/tonal/data`
- Normalization + catalog builder: `tools/fitness/tonal-program-catalog.ts` via `buildTonalProgramCatalog(...)`
- Persist step: `tools/fitness/tonal-plan-artifact.ts` writes the repo snapshot to `memory/fitness/programs/json/current-tonal-catalog.json`
- Markdown companion: `tools/fitness/refresh-current-tonal-catalog.ts` also writes `memory/fitness/programs/md/current-tonal-catalog.md`
- Practical meaning: this file reflects the Tonal movements you have actually performed, with observed set counts, loads, reps, volume, and latest workout timing

## Catalog Builders
- `npx tsx tools/fitness/refresh-current-tonal-catalog.ts` - Refresh the observed Tonal history snapshot directly from `http://localhost:3033/tonal/data` (ex. `memory/fitness/programs/json/current-tonal-catalog.json` and `memory/fitness/programs/md/current-tonal-catalog.md`)
- `npx tsx tools/fitness/tonal-public-movement-catalog.ts` - Scrape Tonal's public Movement Library pages into a local catalog for PPL planning and Tonal-valid exercise selection (ex. `memory/fitness/programs/json/tonal-public-movement-catalog.json` and `memory/fitness/programs/md/tonal-public-movement-catalog.md`)
- `npx tsx tools/fitness/tonal-ppl-v1.ts` - Build a committed PPL v1 artifact from Tonal-valid movements that are actually present in your own history (ex. `memory/fitness/programs/json/tonal-ppl-v1.json` and `memory/fitness/programs/md/tonal-ppl-v1.md`)
