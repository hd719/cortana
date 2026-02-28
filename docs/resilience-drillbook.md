# Resilience Drillbook: 15-Minute Full Recovery SLO

## Objective
Recover the full Cortana runtime stack in **< 15 minutes (900s)** after outage conditions, with an auditable recovery timeline written to `cortana_events`.

---

## Critical Service Inventory

1. **PostgreSQL**
   - Role: Primary state store (`cortana` DB)
   - Health: `pg_isready` + `SELECT 1`
   - Restart: `brew services restart postgresql@17`

2. **Event Bus (DB bridge)**
   - Role: Event fanout from `cortana_events` to `cortana_event_bus_events`
   - Health: table exists + trigger `cortana_events_event_bus_bridge` exists
   - Restart/repair: recreate trigger if missing (function-aware)

3. **OpenClaw Gateway**
   - Role: agent/runtime gateway + scheduler control-plane
   - Health: `openclaw gateway status`
   - Restart: `openclaw gateway restart`

4. **Fitness Service** (`com.cortana.fitness-service`)
   - Role: fitness integrations (Whoop/Tonal)
   - Health: one of:
     - `http://localhost:3033/health`
     - `http://localhost:3033/tonal/health`
     - `http://localhost:3033/whoop/data`
   - Restart: `launchctl kickstart -k gui/$UID/com.cortana.fitness-service`

5. **Watchdog** (`com.cortana.watchdog`)
   - Role: periodic runtime checks + alerting
   - Health: `launchctl print gui/$UID/com.cortana.watchdog`
   - Restart: `launchctl kickstart -k gui/$UID/com.cortana.watchdog`

6. **OpenClaw Crons**
   - Role: scheduled jobs
   - Health: `openclaw cron list` returns scheduler table
   - Restart strategy: gateway restart to rehydrate scheduler state

---

## Runbook Script

Path: `~/openclaw/tools/resilience/drillbook.sh`

### Modes

### 1) Inventory
Prints all critical services + live health status.

```bash
~/openclaw/tools/resilience/drillbook.sh inventory
```

### 2) Recover
Checks each critical service and auto-recovers unhealthy services in dependency order:

**Dependency order:**
`postgres -> event_bus -> gateway -> fitness -> watchdog -> crons`

```bash
~/openclaw/tools/resilience/drillbook.sh recover
```

### 3) Drill
Runs a timed recovery drill and reports RTO + SLO pass/fail.

```bash
~/openclaw/tools/resilience/drillbook.sh drill --simulate-failure all
```

Options:
- `--simulate-failure <target>`: `postgres|event_bus|gateway|fitness|watchdog|crons|all`
- `--live-failure`: intentionally stops services before recovery (**destructive**) 

Example (controlled live drill):
```bash
~/openclaw/tools/resilience/drillbook.sh drill --simulate-failure gateway --live-failure
```

---

## Telemetry / Audit Trail
Each run logs structured milestones to `cortana_events` with:
- `event_type = 'resilience_drillbook'`
- `source = 'tools/resilience/drillbook.sh'`
- severity + message + JSON metadata (elapsed time, service name, recovery outcome, SLO flag)

Quick query:
```bash
export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
psql cortana -c "
  SELECT timestamp, severity, message, metadata
  FROM cortana_events
  WHERE event_type='resilience_drillbook'
  ORDER BY id DESC
  LIMIT 40;
"
```

---

## Verified Baseline (current host)
- Inventory: all 6 critical services healthy.
- Recovery run: completed with no intervention in ~2s.
- Soft drill (`--simulate-failure all`): completed in ~2s, SLO met.

---

## Notes
- `--live-failure` intentionally disrupts services; use only during approved maintenance windows.
- Event bus is modeled as DB objects (table + trigger bridge) in this stack, not a dedicated launchd daemon.
- If PostgreSQL is down, event logging best-effort inserts may be temporarily unavailable until DB restoration.
