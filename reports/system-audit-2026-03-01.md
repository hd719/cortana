# System Reliability Audit — 2026-03-01

Scope:
- `/Users/hd/Developer/cortana-external`
- `/Users/hd/openclaw`

Method:
- Reviewed runtime services (Go fitness service + Mission Control Next.js routes/libs)
- Swept `tools/` + `config/` for script robustness and stale references
- Cross-checked cron payload command paths against actual files

---

## 1) Critical Failure Points (P0/P1)

### [P0] Cron payloads call non-existent scripts (silent job failures / missed alerts)
- `config/cron/jobs.json:1205` references:
  - `~/openclaw/tools/earnings/check-earnings.sh`
  - Actual file present: `tools/earnings/check-earnings.ts`
- `config/cron/jobs.json:1233` references:
  - `~/openclaw/tools/weekly-compounder/weekly-compounder.sh`
  - Actual file present: `tools/weekly-compounder/weekly-compounder.ts`

**Impact:** these jobs will fail at runtime when command execution happens, causing missed daily earnings alerts and weekly scoreboard.

**Action:** update cron payload commands to the real executable entrypoints (`tsx ...ts` or wrapper shell scripts committed alongside TS files).

---

### [P1] Launchd configs point to deleted Python scripts (scheduled automations dead)
- `config/launchd/com.cortana.atomic-fact-extraction.plist:12` → `/Users/hd/openclaw/tools/memory/extract_facts.py` (missing)
- `config/launchd/com.cortana.insight-promotion.plist:12` → `tools/memory/promote_insights.py` (missing)
- `config/launchd/com.cortana.oracle-precompute.plist:12` → `/Users/hd/openclaw/tools/oracle/precompute.py` (missing)
- `config/launchd/com.cortana.system-hygiene-sweep.plist:12` → `/Users/hd/openclaw/tools/hygiene/sweep.py` (missing)
- Current files are TypeScript counterparts (`*.ts`).

**Impact:** these launchd jobs are effectively no-ops/failures if loaded; memory/oracle/hygiene routines won’t run.

**Action:** migrate plist ProgramArguments to TS entrypoints (e.g., `/opt/homebrew/bin/npx tsx ...`) or restore wrappers.

---

### [P1] Shell alert path has no failure checks for Telegram delivery
- `Developer/cortana-external/watchdog/send_telegram.sh:1-8`
  - No `set -euo pipefail`
  - No HTTP status validation
  - Response discarded to `/dev/null`

**Impact:** alert sends can fail silently (network/auth/API errors), masking incidents.

**Action:** enforce strict shell mode + check Telegram API response (`ok:true`) and non-200 responses; bubble failures to watchdog logs/events.

---

### [P1] Multi-write lifecycle ingestion in Mission Control is non-transactional
- `apps/mission-control/lib/openclaw-bridge.ts`
  - Run upsert/update at `131-166`
  - Event insert at `179-201`
  - Task update at `221-225`
  - No `prisma.$transaction(...)` spanning all steps.

**Impact:** partial commits under failures/concurrency (e.g., run updated but event/task not), creating inconsistent operator state and bad dashboards.

**Action:** wrap run+event+task mutation set in one transaction; add idempotency key on event writes for repeat lifecycle deliveries.

---

### [P1] Token/cache writes are non-atomic and unlocked (race/corruption risk)
- `whoop/token_store.go:30-37` uses direct `os.WriteFile`
- `tonal/store.go:42-49`, `65-72` use direct `os.WriteFile`
- Refresh can happen from request path + proactive ticker (`main.go:101-103`, `161-181`) while handlers also read/write.

**Impact:** concurrent writes can truncate/corrupt JSON token/cache files; next reads fail, causing auth churn and endpoint degradation.

**Action:** atomic write pattern (tmp file + fsync + rename) + process-local mutex for token/cache file operations.

---

## 2) Dead Code & Orphans

### [P1] Stale cron/config references to removed features/tables
- `config/cron/jobs.json:791` queries `cortana_watchlist`
- `TOOLS.md` table inventory does not include `cortana_watchlist`.

**Risk:** weekly self-reflection job can emit SQL errors depending on DB state.

**Action:** verify schema ownership of `cortana_watchlist`; either add migration/docs or remove/replace query.

---

### [P2] Legacy launchd Python paths are orphans after TS migration
(See P1 launchd finding.)

**Action:** remove stale plists if no longer used, or keep only one canonical scheduler path (cron vs launchd) to avoid split-brain automation.

---

### [P2] High-probability orphan scripts in `tools/` with no inbound references
Examples found with zero cross-references in repo content:
- `tools/earnings/check-earnings.ts` (exists, but cron still calls `.sh`)
- `tools/weekly-compounder/weekly-compounder.ts` (same mismatch)
- `tools/fitness-service/auto-recover.sh`
- `tools/calendar/prep-detector.ts`
- `tools/monitoring/proprioception-metrics.ts`

**Note:** some may be manual-only. Current state still indicates discoverability/ownership drift.

**Action:** add ownership metadata + invocation map in `tools/README.md` (called-by cron/launchd/manual/test) and delete/archive true orphans.

---

## 3) Refactoring Opportunities

### [P2] Repeated date parsing/token-check shell logic across fitness scripts
- `tools/fitness-service/health-check.sh:11-26`
- `tools/fitness-service/check-token-expiry.sh:11-26`
- `tools/fitness-service/auto-recover.sh:9-24`

All reimplement `parse_epoch` and similar token validation flows.

**Action:** extract shared helper (single sourced shell lib or migrate to one TS utility with tests).

---

### [P2] Inconsistent shell reliability posture (`set -u` only)
- `tools/fitness-service/*.sh`, `tools/tests/run-integration-tests.sh` use `set -u` but not `-e -o pipefail`.
- `Developer/cortana-external/run.sh` and `watchdog/watchdog.sh` are stricter (`set -euo pipefail`).

**Impact:** command failures can be ignored mid-script; downstream checks/logging may report misleading success.

**Action:** standardize strict shell template or migrate critical paths to TypeScript for structured error handling.

---

### [P3] Hardcoded absolute paths reduce portability and drift tolerance
Examples:
- `apps/mission-control/app/api/db-status/route.ts:8` (`/Users/hd/...` LanceDB path)
- `Developer/cortana-external/launchd-run.sh:4,12` fixed absolute repo/env paths
- Multiple cron payloads embed `/Users/hd/...`.

**Action:** centralize path resolution via env/config (`OPENCLAW_HOME`, `CORTANA_EXTERNAL_HOME`) and fail-fast when missing.

---

## 4) Missing Pieces

### [P1] No end-to-end test that validates cron payload commands actually resolve on disk
Current tests focus on unit-level logic; no guard catches command-path drift (e.g., `.sh` vs `.ts` issue above).

**Action:** add CI/cron preflight test: parse `config/cron/jobs.json`, extract command-like paths, assert file existence/executable strategy.

---

### [P2] Fitness service lacks graceful shutdown handling
- `Developer/cortana-external/main.go:156-157` uses `router.Run(...)` directly.
- No signal handling + `http.Server.Shutdown` path.

**Impact:** abrupt restarts can cut in-flight auth refresh/data writes.

**Action:** switch to explicit `http.Server`, trap SIGTERM/SIGINT, graceful shutdown with timeout.

---

### [P2] Health checks are present but alert transport health is not monitored as first-class SLI
- Service health endpoints exist (`/health`, `/whoop/health`, `/tonal/health`, `/alpaca/health`), but send path (`send_telegram.sh`) does not verify delivery.

**Action:** add alert-delivery health metric + retry/backoff + dead-letter logging on failed sends.

---

## Prioritized Remediation Plan

1. **Immediate (today):** fix cron command path mismatches (`check-earnings`, `weekly-compounder`).
2. **Immediate (today):** patch `send_telegram.sh` for strict mode + response validation.
3. **Short term (1-2 days):** migrate/fix launchd plists to TS entrypoints or decommission stale plists.
4. **Short term (2-4 days):** transactionalize `ingestOpenClawLifecycleEvent` writes.
5. **Short term (2-4 days):** implement atomic+locked token/cache writes in Whoop/Tonal stores.
6. **Next sprint:** add cron payload path integration test and standardize shell reliability baseline.

---

## Notes
- This was read-only analysis; no existing files were modified.
- Findings are focused on concrete break/failure vectors over stylistic preferences.
