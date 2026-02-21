# Self-Healing Verification Loop

**Upgrade Proposal #2**

## Problem

The immune system currently implements a "fix-and-forget" pattern that can lead to silent failures. Recent incident: Tonal path configuration was incorrect, triggering 10 consecutive failed self-healing attempts. The immune system kept retrying the same fix (path correction) without verifying if the fix actually resolved the underlying issue. Each attempt was logged as "resolved" because the playbook executed successfully, but the root cause persisted.

This creates a false sense of security where:
- Playbooks execute without errors → marked as "success"
- Underlying problem remains unresolved
- System continues to degrade silently
- No escalation occurs despite repeated failures

## Proposed Solution

Implement a **verify-after-fix** pattern:

1. **Execute Fix Playbook** - Run the standard remediation
2. **Wait Period** - Allow system to stabilize (30-60 seconds)
3. **Verification Check** - Re-run the original detection logic
4. **Status Update** - Mark as truly resolved only if verification passes
5. **Escalation** - If verification fails 3+ times, escalate to human attention

## Implementation Plan

### 1. Update immune-scan cron
- Add verification step after each playbook execution
- Implement backoff delays between fix attempts
- Track verification success/failure rates

### 2. Modify watchdog service  
- Extend incident tracking to include verification status
- Add escalation logic for repeatedly failing verifications
- Surface verification metrics in health dashboard

### 3. Enhance playbook system
- Each playbook gets a companion verification script
- Standard verification interface: exit 0 = fixed, exit 1 = still broken
- Timeout protection for verification checks

### 4. Database schema updates
- Add `verification_status` and `verification_attempts` to `cortana_immune_incidents`
- Track verification success rates per playbook type
- Log verification failures separately from execution failures

## Affected Components

**Crons:**
- `immune-scan` - Primary self-healing orchestrator
- `watchdog` - System health monitoring
- `fitness-sync` - Tonal/Whoop data pipeline monitoring

**Systems:**
- Immune system playbook registry
- Health dashboard proprioception
- Auto-throttling mechanisms
- Alert escalation pipeline

**Existing Playbooks:**
- Path correction (Tonal fitness data)
- Service restart procedures  
- Disk space cleanup
- OAuth token refresh cycles

## Effort: Medium

- **Code changes:** ~2-3 days (verification framework + playbook updates)
- **Testing:** ~1 day (simulate failures, verify escalation)
- **Migration:** ~0.5 days (database schema, existing incident cleanup)

## Success Criteria

1. **Zero false positives:** No incidents marked "resolved" when problem persists
2. **Escalation works:** Failed verifications (3+) trigger human alerts within 15 minutes
3. **Metrics visibility:** Verification success rates visible in morning briefs
4. **Reduced noise:** Genuine resolutions decrease repeat incidents by 80%+
5. **Backward compatibility:** Existing playbooks work with minimal modification

## Rollout Plan

1. **Phase 1:** Framework implementation (verification hooks, database updates)
2. **Phase 2:** Update high-impact playbooks (Tonal path, service restarts)
3. **Phase 3:** Gradual migration of remaining playbooks
4. **Phase 4:** Remove legacy "fix-and-forget" code paths

---

*Created: 2026-02-20*  
*Status: Proposed*  
*Priority: High (prevents silent failures)*