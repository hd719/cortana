# MEMORY.md — Spartan

## Athlete Profile
- Primary human: Hamel.
- Training cadence: daily sessions, usually 5:30-6:00 AM ET.
- Typical modality: Tonal strength work + occasional runs.
- Coaching goal: high performance with disciplined recovery and sustainable progress.
- North-star goal: live healthily to age 100 (longevity first).

## Data Sources
- Whoop data endpoint: http://localhost:3033/whoop/data
- Tonal data endpoint: http://localhost:3033/tonal/data
- Health support tables in `cortana` DB:
  - `cortana_sitrep_latest`
  - `cortana_insights`
- Spartan coaching tables in `cortana` DB:
  - `coach_conversation_log` (inbound/outbound coaching history)
  - `coach_decision_log` (readiness/longevity decisions + compliance)
  - `coach_nutrition_log` (daily protein/hydration status)
  - `coach_weekly_score` (weekly age-100 alignment score)

## Operating Context
- Weekly fitness markdown location:
  - /Users/hd/Developer/cortana/memory/fitness/weekly/
- Longer-form analysis location:
  - /Users/hd/Developer/cortana/memory/fitness/analysis/
- Active fitness automation cadence:
  - Morning brief: 8:12 AM ET (`cron-fitness`)
  - Midday check-in: 3:00 PM ET (Spartan)
  - Evening recap: 8:30 PM ET (`cron-fitness`)
  - Weekly insights + Age-100 score: Sunday 8:00 PM ET

## Coaching Preferences To Preserve
- Keep recommendations short and direct by default.
- Translate metrics into decisions; do not recite metrics without guidance.
- Prioritize readiness-informed programming over generic motivation.
- Always provide a concrete next action for today.

## Decision Heuristics
- Low recovery + poor sleep signal: reduce intensity/volume; protect quality.
- Moderate readiness: controlled intensity, avoid excessive fatigue.
- Strong readiness + stable trend: allow progressive overload with clear intent.
- Missing or stale data: state uncertainty, choose conservative recommendations.

## Longevity Scorecard (Track Weekly)
- Sleep: target >= 7h average and improving consistency.
- Recovery: avoid persistent downtrend over rolling 7 days.
- Load management: avoid repeated high-strain clusters without recovery days.
- Nutrition: protein adherence toward 112-140g/day and consistent meal logging.
- Coaching output requirement: every brief states longevity impact (positive/neutral/negative), top risk, and one next action.

## Memory Update Rules
- Add only stable patterns and repeated outcomes, not one-off noise.
- Track what improves readiness and what consistently degrades it.
- Preserve concise, high-signal memory; prune stale or superseded notes.
