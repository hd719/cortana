# Technical Specification - Spartan Health Expansion

**Document Status:** Implemented

Shipped on `main`; retained as the technical reference for the current system.

## Team

| Role | Assignee |
|------|----------|
| Owner(s) | @hd |
| Epic | Spartan Health Expansion |

---

## Development Overview

Add Apple Health as a later-stage source of truth for body weight, step totals, distance, and energy expenditure by introducing a local export-based ingestion contract in `cortana-external` and integrating the normalized daily health summary into Cortana's athlete-state and body-composition logic. Keep the first implementation privacy-preserving, file-based, and read-only, avoid direct iOS/macOS HealthKit app work unless needed later, and encode reconciliation, freshness, and conflict-resolution rules in deterministic code and tests so the expansion remains LLM agnostic.

---

## Data Storage Changes

### Database Changes

#### [NEW] public.cortana_fitness_health_source_daily

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| PK part 1, NOT NULL | metric_date | DATE | Local date of the measurement. |
| PK part 2, NOT NULL | metric_name | TEXT | `body_weight_kg`, `steps`, `active_energy_kcal`, `resting_energy_kcal`, `walking_running_distance_km`, `body_fat_pct`, and similar. |
| PK part 3, NOT NULL | source_name | TEXT | `apple_health`, `whoop`, `manual_override`, or future source. |
|  | metric_value | NUMERIC(12,3) | Numeric value. |
|  | unit | TEXT | `kg`, `count`, `kcal`, `km`, `pct`, etc. |
|  | freshness_hours | NUMERIC(8,2) | Freshness at ingest time. |
|  | source_confidence | NUMERIC(4,3) | Trust score for this row. |
| NOT NULL, DEFAULT `'{}'::jsonb` | provenance | JSONB | Export file path, ingest time, exporter version, and similar metadata. |
| NOT NULL, DEFAULT NOW() | created_at | TIMESTAMPTZ | Creation timestamp. |

#### [UPDATE] public.cortana_fitness_athlete_state_daily

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| Existing | body_weight_kg | NUMERIC(6,2) | Now populated from preferred-source reconciliation. |
|  | body_weight_source | TEXT | Preferred source name for the selected weight. |
|  | body_weight_confidence | NUMERIC(4,3) | Confidence for selected body weight. |
|  | active_energy_kcal | NUMERIC(8,2) | Preferred active-energy source. |
|  | resting_energy_kcal | NUMERIC(8,2) | Preferred resting-energy source. |
|  | walking_running_distance_km | NUMERIC(8,2) | Daily locomotion distance. |
|  | body_fat_pct | NUMERIC(6,3) | Optional body-fat metric if available. |
|  | lean_mass_kg | NUMERIC(8,2) | Optional lean-mass metric if available. |
|  | health_source_confidence | NUMERIC(4,3) | Aggregate confidence for Apple Health-derived inputs. |
| NOT NULL, DEFAULT `'{}'::jsonb` | health_context | JSONB | Reconciliation context and source provenance. |

#### [NEW] public.cortana_fitness_body_composition_weekly

| Constraints | Column Name | Column Type | Notes |
|-------------|-------------|-------------|-------|
| PK, NOT NULL | iso_week | TEXT | Weekly key. |
| NOT NULL | week_start | DATE | Week start. |
| NOT NULL | week_end | DATE | Week end. |
|  | avg_body_weight_kg | NUMERIC(8,2) | Average body weight for the week. |
|  | weight_delta_pct | NUMERIC(6,3) | Weekly percent change. |
|  | avg_steps | NUMERIC(8,2) | Average daily steps. |
|  | avg_active_energy_kcal | NUMERIC(8,2) | Average daily active energy. |
|  | avg_resting_energy_kcal | NUMERIC(8,2) | Average daily resting energy. |
|  | body_fat_pct_latest | NUMERIC(6,3) | Optional latest body-fat reading. |
|  | lean_mass_kg_latest | NUMERIC(8,2) | Optional latest lean-mass reading. |
|  | confidence | NUMERIC(4,3) | Aggregate trust in the weekly body-comp summary. |
| NOT NULL, DEFAULT `'{}'::jsonb` | quality_flags | JSONB | Missing weight trend, sparse steps, inconsistent source, and similar warnings. |
| NOT NULL | created_at | TIMESTAMPTZ | Creation timestamp. |
| NOT NULL | updated_at | TIMESTAMPTZ | Update timestamp. |

---

## Infrastructure Changes (if any?)

### SNS Topic Changes

None.

### SQS Queue Changes

None.

### Cache Changes

New local file-based cache/input contract in `cortana-external`:

- config variable such as `APPLE_HEALTH_DATA_PATH`
- recommended default path: `~/.openclaw/data/apple-health/latest.json`
- optional archive directory for historical raw imports

The external service should:

- validate file freshness and schema
- serve normalized data
- expose healthcheck status

### S3 Changes

None.

### Secrets Changes

None in the first release because the ingest is local and file-based.

### Network/Security Changes

None expected. Health data should remain local on the current machine.

---

## Behavior Changes

- Athlete state gains trustworthy body-weight and step inputs when Apple Health is configured and fresh.
- Cut and gain logic can use actual weekly weight trend instead of null or guessed values.
- Monthly and weekly summaries can distinguish:
  - missing step data
  - low-confidence body weight
  - good activity coverage with sparse body-composition coverage
- If Apple Health is stale or unavailable, the system falls back explicitly and lowers confidence rather than silently switching sources.

---

## Application/Script Changes

New files in `cortana-external`:

- `apps/external-service/src/apple-health/service.ts`
  - read and validate the local export file
- `apps/external-service/src/apple-health/routes.ts`
  - expose `/apple-health/data` and `/apple-health/health`
- `apps/external-service/src/apple-health/index.ts`
  - wire the service into the app
- `apps/external-service/src/__tests__/apple-health.test.ts`
  - route and schema validation coverage
- `mjolnir/APPLE_HEALTH_SERVICE.md`
  - local service docs

Updated files in `cortana-external`:

- `apps/external-service/src/config.ts`
  - add Apple Health data-path config
- `apps/external-service/src/app.ts`
  - register the new service and routes
- `apps/external-service/src/health.ts`
  - include Apple Health in aggregate health if desired later

New files in `cortana`:

- `tools/fitness/health-source-db.ts`
  - schema creation and query helpers for normalized daily health-source rows
- `tools/fitness/body-composition-engine.ts`
  - preferred-source reconciliation and weekly body-weight trend logic

Updated files in `cortana`:

- `tools/fitness/athlete-state-data.ts`
  - read normalized Apple Health metrics and populate health-context fields
- `tools/fitness/athlete-state-db.ts`
  - support new athlete-state health fields
- `tools/fitness/goal-mode.ts`
  - consume real body-weight trend for cut/gain pace
- `tools/fitness/monthly-overview-data.ts`
  - expose better activity and body-composition coverage diagnostics
- `tools/fitness/weekly-plan-data.ts` or equivalent
  - incorporate weekly weight trend into cut/gain recommendations if available

Recommended export contract:

```json
{
  "exported_at": "2026-04-04T08:00:00-04:00",
  "source": "apple_health_shortcut_v1",
  "days": [
    {
      "date": "2026-04-04",
      "body_weight_kg": 78.4,
      "steps": 10432,
      "active_energy_kcal": 612,
      "resting_energy_kcal": 1844,
      "walking_running_distance_km": 7.9,
      "body_fat_pct": null,
      "lean_mass_kg": null
    }
  ]
}
```

LLM-agnostic requirement:

- Reconciliation rules such as preferred source, stale fallback, and confidence weighting must be deterministic code.
- The export contract must be schema-validated before use.

---

## API Changes

### [NEW] Apple Health Internal Health Endpoint

| Field | Value |
|-------|-------|
| **API** | `GET /apple-health/health` |
| **Description** | Returns status and freshness information for the local Apple Health export source. |
| **Additional Notes** | Mirrors existing provider health endpoints. |

| Field | Detail |
|-------|--------|
| **Authentication** | None on localhost service |
| **URL Params** | None |
| **Request** | None |
| **Success Response** | JSON such as `{ "status": "healthy", "freshness_hours": 3.2, "path": ".../latest.json", "days": 30 }` |
| **Error Responses** | `503`-style unhealthy payload when file missing, invalid, or stale beyond threshold |

### [NEW] Apple Health Internal Data Endpoint

| Field | Value |
|-------|-------|
| **API** | `GET /apple-health/data` |
| **Description** | Returns the normalized Apple Health export payload used by Cortana fitness logic. |
| **Additional Notes** | Read-only local endpoint. |

| Field | Detail |
|-------|--------|
| **Authentication** | None on localhost service |
| **URL Params** | None |
| **Request** | None |
| **Success Response** | Validated JSON export with freshness metadata |
| **Error Responses** | Route returns unhealthy or empty state if the export cannot be validated |

---

## Process Changes

- Add a local Apple Health export step outside the repos:
  - manual export or Shortcut
  - written to a known local file path
- Add a health-source ingest step before athlete-state generation when the export is present and fresh.
- Define preferred-source rules centrally so weekly and monthly outputs do not each reconcile sources differently.

---

## Orchestration Changes

No cloud orchestration changes are required.

Local orchestration sequence:

1. refresh or place the Apple Health export file
2. external-service validates and serves it
3. Cortana ingests normalized health rows
4. athlete-state rebuild consumes preferred-source metrics
5. body-composition weekly summary is refreshed

---

## Test Plan

`cortana-external`

- Add `apps/external-service/src/__tests__/apple-health.test.ts`.
- Verify:
  - valid export file parses successfully
  - missing file returns unhealthy status
  - stale file returns unhealthy or degraded status according to policy
  - `/apple-health/data` and `/apple-health/health` return expected payloads

`cortana`

- Add `tests/cron/fitness-health-source-db.test.ts`
- Add `tests/cron/fitness-body-composition-engine.test.ts`
- Update:
  - `tests/cron/fitness-athlete-state-data.test.ts`
  - `tests/cron/fitness-monthly-overview-data.test.ts`
  - `tests/cron/fitness-weekly-insights-data.test.ts` if weekly weight trend is surfaced

Expected coverage:

- source reconciliation and confidence weighting
- athlete-state population from Apple Health rows
- weekly body-weight trend and cut/gain pace logic
- stale and missing export fallback behavior
