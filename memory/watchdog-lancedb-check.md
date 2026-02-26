# Watchdog LanceDB / Memory Extension Healthcheck

Date: 2026-02-25

## Summary

Added a dedicated LanceDB / OpenClaw memory extension healthcheck to the Cortana watchdog so that failures of the LanceDB npm dependency no longer fail silently.

## Implementation Details

**File:** `~/Developer/cortana-external/watchdog/watchdog.sh`

### New Healthcheck

Extended the `check_tools()` function with a LanceDB memory extension probe, placed alongside the existing PostgreSQL/tool checks.

```bash
  # PostgreSQL
  local pg_check_name="postgresql"
  if ! psql cortana -c "SELECT 1;" &>/dev/null; then
    alert "PostgreSQL is DOWN" "$pg_check_name" "critical"
  else
    recovery_alert "$pg_check_name" "PostgreSQL recovered and is running"
    log "info" "PostgreSQL: OK"
  fi

  # LanceDB / Memory Extension
  local lancedb_check_name="memory_extension"
  if ! node --prefix /opt/homebrew/lib/node_modules/openclaw -e "require('@lancedb/lancedb')" &>/dev/null; then
    # Log a dedicated memory_extension_down event in addition to the generic watchdog log
    psql cortana -c "INSERT INTO cortana_events (event_type, source, severity, message) VALUES ('memory_extension_down', 'watchdog', 'high', 'LanceDB memory extension failed healthcheck');" &>/dev/null || true
    alert "LanceDB memory extension healthcheck FAILED" "$lancedb_check_name" "critical"
  else
    recovery_alert "$lancedb_check_name" "LanceDB memory extension healthcheck passed"
    log "info" "LanceDB memory extension: OK"
  fi
```

### Behavior

- **Health probe:**
  - Runs `node --prefix /opt/homebrew/lib/node_modules/openclaw -e "require('@lancedb/lancedb')"` as a fast sanity check that the LanceDB npm dependency is installed and loadable in the OpenClaw environment.

- **On failure:**
  - Inserts a dedicated event into `cortana_events`:
    ```sql
    INSERT INTO cortana_events (event_type, source, severity, message)
    VALUES ('memory_extension_down', 'watchdog', 'high', 'LanceDB memory extension failed healthcheck');
    ```
  - Calls `alert "LanceDB memory extension healthcheck FAILED" "memory_extension" "critical"`, which:
    - Appends a 🚨 entry to the watchdog alert buffer
    - Logs via the existing `log()` helper
    - Applies the standard alert suppression/recovery semantics using `watchdog-state.json`

- **On success:**
  - Calls `recovery_alert "memory_extension" "LanceDB memory extension healthcheck passed"` so a recovery notice is sent if the check was previously failing.
  - Logs an informational line: `LanceDB memory extension: OK`.

### Notes

- This check will fire any time the LanceDB dependency goes missing or becomes unloadable in the OpenClaw runtime (e.g., npm uninstall, version mismatch, or broken install), preventing silent loss of the memory extension.
- The explicit `memory_extension_down` row in `cortana_events` makes it easy to query historical outages of the memory system independent of other watchdog events.
