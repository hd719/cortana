# Fitness Hybrid Migration Plan (TS Wrapper + Go Core)

## Scope audited
- Go service: `/Users/hd/Developer/cortana-external` (`main.go`, `whoop/*`, `tonal/*`)
- TypeScript repos checked for overlap:
  - `/Users/hd/Developer/cortana-external/apps/mission-control`
  - `/Users/hd/Developer/cortex-plane` (monorepo)

---

## 1) Current Go fitness service map

### API endpoints → handlers

| Endpoint | Handler | File |
|---|---|---|
| `GET /auth/url` | `AuthURLHandler` | `whoop/handler.go` |
| `GET /auth/callback` | `CallbackHandler` | `whoop/handler.go` |
| `GET /whoop/data` | `DataHandler` | `whoop/handler.go` |
| `GET /tonal/health` | `HealthHandler` | `tonal/handler.go` |
| `GET /tonal/data` | `DataHandler` | `tonal/handler.go` |

Note: Service is mounted by Gin in `main.go` and bound to `127.0.0.1:3033`.

### Shared types currently in Go

#### Whoop
- `TokenResponse` (OAuth token payload)
- `TokenData` (persisted token file)
- `WhoopData` (API response contract):
  - `profile: map[string]any`
  - `body_measurement: map[string]any`
  - `cycles: []map[string]any`
  - `recovery: []map[string]any`
  - `sleep: []map[string]any`
  - `workouts: []map[string]any`
- `collectionResponse` for paginated records

#### Tonal
- `TokenData` (id/refresh token persistence)
- `StrengthScoreData` (`current`, `history`)
- `TonalCache` (persisted merged cache)
- `DataResponse` (public contract):
  - `profile: map[string]any`
  - `workouts: map[string]any`
  - `workout_count: int`
  - `strength_scores: StrengthScoreData`
  - `last_updated: time.Time`

### Performance-critical / reliability-critical paths (keep in Go)

1. **Whoop fetch orchestration** (`fetchAllWhoopData`):
   - Multiple upstream calls + pagination (`limit=25`, `maxPages=5`).
   - In-memory TTL cache (`5m`) to reduce repeated upstream calls.

2. **Tonal incremental cache merge** (`tonal_data.json`):
   - Pulls recent workouts and merges by workout id.
   - Preserves long-term history over time from partial API windows.

3. **Auth/token lifecycle + self-heal**
   - Whoop OAuth exchange/refresh + token persistence.
   - Tonal refresh-token-first flow with password fallback.
   - Tonal self-heal on 401/403: deletes token file, re-auth, single retry.

4. **Request pacing / contention control**
   - Tonal rate limiting delay (`RequestDelay`, default 500ms).
   - Tonal handler mutex prevents concurrent cache corruption.

### Integration points with other services

- Used heavily by scripts/automation in `/Users/hd/openclaw`:
  - `tools/fitness/*`, `skills/fitness-coach/*`, watchdog health checks, cron jobs.
- Launchd-managed service (`com.cortana.fitness-service`) is dependency for daily briefs/health automations.
- Watchdog checks `GET /tonal/health` and `GET /whoop/data` for uptime.

---

## 2) TypeScript monorepo overlap findings

### Direct overlap discovered
- **Very little typed overlap today.**
- In Mission Control TS code, only one call to fitness service was found:
  - `app/api/actions/[action]/route.ts` calls `curl http://localhost:3033/health`.
  - This is currently misaligned with actual Go endpoints (no `/health`; health endpoints are `/tonal/health` and `/whoop/data`).

### What this means
- There is currently **no strong TS type duplication** for Whoop/Tonal payloads in checked TS repos.
- The biggest win is not “dedupe existing TS types,” but **creating first-class shared TS contracts now** so all TS callers stop using ad-hoc JSON assumptions/curl glue.

---

## 3) Migration recommendation (practical hybrid)

## MOVE TO TS (high code-sharing payoff)

1. **Canonical API contracts package** (new): `packages/fitness-contracts`
   - Zod schemas + inferred TS types for:
     - `WhoopData`
     - `TonalDataResponse`
     - `TonalHealthResponse`
     - normalized error envelope
   - Keep raw passthrough fields where payloads are still dynamic (`record<string, unknown>`), but lock stable outer contract.

2. **Typed TS client wrapper** (new): `packages/fitness-client`
   - `getWhoopData()`, `getTonalData()`, `getTonalHealth()`
   - Runtime validation via Zod (fail fast + telemetry)
   - Retry/timeouts in TS caller layer for UX and dashboard use

3. **TS-facing BFF routes (optional but useful)**
   - Add server functions/API routes in monorepo that proxy Go and return typed DTOs.
   - Benefits: internal auth/rate controls, caching headers, and one call surface for UI/apps.

## KEEP IN GO (do not rewrite)

1. Upstream API choreography (Whoop/Tonal call sequence + pagination)
2. Token management and refresh semantics
3. Tonal self-healing and token reset behavior
4. In-memory and file-backed caches + mutex/rate-limiting behavior
5. Launchd/watchdog operational coupling

Reason: these are reliability-sensitive paths already tuned to provider behavior and local ops.

## BRIDGE LAYER (TS ↔ Go)

**Recommended now: HTTP + OpenAPI contract generation (internal loopback).**

- Keep Go service as loopback HTTP core on `127.0.0.1:3033`.
- Add OpenAPI spec (hand-written first, generated later) for fitness endpoints.
- Generate TS client/types from OpenAPI OR keep Zod-first schemas and derive OpenAPI from Zod.

Why not gRPC now:
- Adds complexity with limited local single-host benefit.
- Current integrations are script/HTTP based; HTTP bridge is lower-friction and safer incrementally.

---

## 4) Migration order (with risk notes)

### Phase 1 — Contract hardening (Small)
- Define Zod schemas + TS types for current Go responses.
- Add fixture-based contract tests against sample payloads.
- Fix Mission Control health check endpoint mismatch (`/health` → `/tonal/health` or combined check).

**Risk:** schema too strict for provider drift.  
**Mitigation:** strict outer envelope, permissive nested dynamic fields at first.

### Phase 2 — Typed TS wrapper adoption (Medium)
- Build `fitness-client` package and replace raw curl/ad-hoc fetch usage in TS apps.
- Centralize retries, timeout defaults, and error typing.

**Risk:** behavior differences from shell scripts.  
**Mitigation:** keep Go payload unchanged; add snapshot tests comparing old/new call outputs.

### Phase 3 — Optional BFF normalization (Medium)
- Introduce TS server route(s) that normalize Go responses for UI clients.
- Example: provide `todayWorkoutSummary`, `latestRecovery`, etc., while preserving raw passthrough endpoints.

**Risk:** accidental double-caching/stale data.  
**Mitigation:** explicit TTLs and no hidden persistence in TS BFF initially.

### Phase 4 — Go internal type tightening (Large, optional)
- Incrementally replace `map[string]any` internals with typed structs where stable.
- Keep public contract backward-compatible.

**Risk:** high churn with low immediate ROI.  
**Mitigation:** do only on hotspots where bugs/maintenance cost is proven.

---

## 5) Estimated effort summary

- Phase 1: **Small** (1–2 days)
- Phase 2: **Medium** (3–5 days)
- Phase 3: **Medium** (3–4 days)
- Phase 4: **Large** (1–2+ weeks, optional)

---

## Bottom line

Do **not** migrate core fitness logic out of Go.  
Migrate **contracts + client ergonomics** to TS so monorepo apps share one typed interface and stop relying on implicit JSON shapes. This gets the code-sharing win without destabilizing auth/cache/reliability behavior.