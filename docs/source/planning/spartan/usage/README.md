# Spartan Operator Guide

This guide covers how to get the most useful output from Spartan as it exists today.

## What Spartan Does Best Right Now

- turns Whoop, Tonal, meal logs, and coach decisions into a daily readiness and training recommendation
- writes persistent daily, weekly, and monthly artifacts into `memory/fitness/`
- generates tomorrow's Tonal session plan and links it back to recommendation state
- flags real coaching risks such as recovery drag, stale data, pain, schedule conflicts, and protein misses

## Minimum Working Setup

Spartan is most useful when these are true:

- `cortana-external` is running and `http://127.0.0.1:3033/health` returns overall `ok`
- Whoop is authenticated and `http://127.0.0.1:3033/whoop/health` returns `authenticated: true`
- Tonal is authenticated and `http://127.0.0.1:3033/tonal/health` returns `status: "healthy"`
- meal logs or coach nutrition entries exist if you want protein and hydration coaching to be trustworthy

Apple Health is optional for now. If the export file is not configured, Spartan should show `appleHealth.status = "unconfigured"` rather than failing.

## HealthBridge On iPhone

HealthBridge is the supported native iPhone producer for Apple Health data. It exports the canonical daily payload and posts it to the local importer.

Source location:

- `/Users/hd/Developer/cortana-external/apps/health-bridge-ios`

Minimum setup:

1. Install HealthBridge on the iPhone.
2. Set the server URL to a reachable `cortana-external` host, for example a Mac mini LAN IP or Tailscale hostname. `http://127.0.0.1:3033` will not work from the phone.
3. Set the API token to match `APPLE_HEALTH_API_TOKEN` if the importer is protected.
4. Set a stable device name.
5. Grant HealthKit read permissions on a real iPhone.

To send data, HealthBridge posts the Apple Health export to:

```bash
curl -s \
  -X POST http://127.0.0.1:3033/apple-health/import \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  --data-binary @/path/to/apple-health-export.json | jq .
```

Verify the importer:

```bash
curl -s http://127.0.0.1:3033/apple-health/health | jq .
```

After a successful import, rerun the morning brief so Spartan ingests the imported rows into athlete state:

```bash
npx tsx tools/fitness/morning-brief-data.ts
```

When HealthBridge is active, expect `stepCount`, `bodyWeightKg`, `activeEnergyKcal`, and related health fields to appear in the athlete-state payload with `source: "apple_health"`.

## Daily Operator Loop

### Morning

Run:

```bash
npx tsx tools/fitness/morning-brief-data.ts
```

Use it to confirm:

- `errors` is empty
- `today_training_recommendation.mode` looks plausible for current readiness
- `tomorrow_tonal_plan` exists and has a stable `id`
- `apple_health.status` is either `healthy` or `unconfigured`, not `unhealthy`

### During The Day

To improve coaching quality, log:

- meals, especially protein-dense meals
- hydration when possible
- post-workout notes if pain, joint irritation, or unusual fatigue shows up
- check-ins when motivation, soreness, or schedule changes would alter the plan

### Evening

Run:

```bash
npx tsx tools/fitness/evening-recap-data.ts
```

Use it to confirm:

- training load and nutrition assumptions still look believable
- `errors` is empty
- `apple_health.status` is not breaking the recap

## Weekly Operator Loop

Run:

```bash
npx tsx tools/fitness/weekly-insights-data.ts
npx tsx tools/fitness/weekly-plan-data.ts
npx tsx tools/fitness/fitness-alerts-data.ts --types=freshness,recovery_risk,overreach,protein_miss,pain,schedule_conflict
```

Focus on:

- whether the weekly recommendation mode makes sense
- whether alerts are actionable instead of noisy
- whether underdosed or overdosed muscle logic matches reality
- whether recovery and nutrition caveats are due to bad behavior or missing data

## Monthly Operator Loop

Run:

```bash
npx tsx tools/fitness/monthly-overview-data.ts
```

Expect low confidence until enough daily athlete-state rows exist. Monthly output is useful only after Spartan has several weeks of consistent data.

## How To Get The Best Coaching

- keep Whoop and Tonal authenticated at all times
- log protein consistently; without this, Spartan defaults conservative and assumes under-fueling risk
- treat body weight as a core signal if you want cut, maintenance, or lean-gain guidance to improve
- review the `memory/fitness/` artifacts instead of only trusting one chat response
- rerun morning and evening scripts after material data changes instead of waiting for stale artifacts

## What To Watch Closely

- `quality_flags.missing_phase_mode`: body-composition strategy is still underinformed
- `quality_flags.health_quality_flags`: health-source coverage is thin
- repeated Whoop duplicate-removal flags: not fatal, but they tell you provider hygiene is still doing work
- low coverage on weight, steps, meals, and protein: this weakens confidence more than the models do

## Merge / Launch Readiness Checklist

Before relying on Spartan Monday morning:

- `cortana` Spartan fitness tests are green
- `cortana-external` health/provider tests are green
- live `morning-brief-data.ts`, `evening-recap-data.ts`, `weekly-insights-data.ts`, `weekly-plan-data.ts`, `monthly-overview-data.ts`, and `fitness-alerts-data.ts` all run without runtime errors
- `/health` is `ok`
- Whoop and Tonal are healthy
- tomorrow-session planner writes are idempotent on reruns

If those are true, the remaining risks are mostly data quality and coverage, not broken execution paths.
