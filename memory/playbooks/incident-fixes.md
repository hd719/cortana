# Self-Healing Knowledge Base

Purpose: practical incident response notes for future-Cortana. Focused on fast diagnosis, lowest-risk fix, and prevention.

## Tonal Auth Failure (401/403 unauthorized)
- **Symptom**: Tonal API returns unauthorized; health endpoint shows unhealthy/auth failure.
- **Root cause**: Expired or stale token state (`tonal_tokens.json` or `~/.tonal/token.json` depending on service path).
- **Fix**:
  1. Delete stale token file.
  2. Restart or re-run fitness/Tonal health check flow to force token refresh.
  3. Verify Tonal endpoint returns healthy.
- **Known auto-heal signals**:
  - `cortana_events`: `auth_expired` + `auto_heal` from `tonal_auth` / `fitness_healthcheck`.
  - `cortana_immune_incidents`: `auth_failure` with playbooks like `tonal_auth_reset`, `tier1_auth_refresh`.
- **Prevention**:
  - Keep Tonal health check cadence active (every ~4h).
  - Prefer refresh-token self-heal path in service code over repeated manual resets.
  - Log each heal to `cortana_events`.

## Oversized OpenClaw Session Files (context bloat)
- **Symptom**: Session files exceed ~400KB, context overflows, performance and cron reliability degrade.
- **Root cause**: Long-running sessions accumulating excessive JSON payloads.
- **Fix**:
  1. Delete oversized session JSON files (`>400KB`) in OpenClaw sessions dir.
  2. Re-run affected cron/session flow.
- **Known auto-heal signals**:
  - `cortana_events`: `auto_heal` from `session_cleanup`, `immune_scan`, `heartbeat_cleanup`.
  - Messages like `Deleted bloated session file` / `Cleaned oversized session`.
- **Prevention**:
  - Keep periodic cleanup automation enabled.
  - Add guardrails on cron output size and context usage.

## Cron Failure / Missed Jobs
- **Symptom**: crons reported as missed or repeated failure streaks.
- **Root cause**: scheduler drift, transient runtime errors, or stuck job state.
- **Fix**:
  1. Re-trigger missed cron (`openclaw cron run <jobId>`).
  2. For consecutive failures, apply cron unstick playbook and recheck status.
  3. If systematic, restart gateway/scheduler layer.
- **Known playbooks**: `missed_cron`, `cron_unstick`, `gateway_restart`.
- **Prevention**:
  - Track consecutive failures in cron health telemetry.
  - Escalate only persistent 5+ failure streaks.

## Tonal Endpoint Misroute / False API Outage
- **Symptom**: direct checks to one endpoint fail (e.g., localhost:8080 or wrong Tonal public endpoints), but service may still be healthy on fallback.
- **Root cause**: endpoint mismatch or testing wrong API path/version.
- **Fix**:
  1. Validate both local service endpoints (e.g., `:8080` and fallback `:3033`).
  2. Confirm against the service’s actual production API path, not guessed endpoints.
  3. If fallback is healthy, avoid destructive remediation.
- **Prevention**:
  - Keep endpoint config documented and tested.
  - Distinguish true outage from diagnostic false positive.

## Weather API Transient Failures
- **Symptom**: weather tool timeout/invalid response.
- **Root cause**: transient external API/network issue.
- **Fix**:
  1. Retry request.
  2. Confirm recovery before escalating.
- **Known playbook**: `weather_tool_down` / `weather_retry`.
- **Prevention**:
  - Treat first failure as transient.
  - Alert only if repeated failures persist.

## Service/Path Mismatch for Tonal Tokens
- **Symptom**: auth resets appear successful, but service still reads stale token from another location.
- **Root cause**: token file path mismatch between skill docs and running service config.
- **Fix**:
  1. Confirm active token path used by running service.
  2. Clear token in actual runtime location.
  3. Re-run auth flow and verify health.
- **Prevention**:
  - Keep runtime path contract documented in one place.
  - Add startup self-check that logs token path and warns on mismatch.

## Quick triage checklist
1. **Classify**: auth, cron, session bloat, endpoint/connectivity, external transient.
2. **Check recent events** in `cortana_events` for same signature and prior successful fix.
3. **Apply lowest-risk known playbook** first.
4. **Verify recovery** (health endpoint + latest data freshness), don’t assume.
5. **Log outcome** in events/incidents tables so future retries stay deterministic.
