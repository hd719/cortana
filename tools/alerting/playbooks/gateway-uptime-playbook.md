# Gateway Uptime Playbook

**Scope:** OpenClaw Gateway availability on this host.

## 1) Probe and failure threshold
- **Probe command:**
  ```bash
  openclaw gateway status
  ```
- **Healthy:** command exits `0` and reports running/healthy.
- **Failure:** non-zero exit, timeout, or status not running.
- **Trigger threshold:** **2 consecutive failed probes** before remediation.
- **Suggested probe interval:** every 2 minutes.

## 2) Remediation action
After 2 consecutive failures:
```bash
openclaw gateway restart
```

## 3) Post-restart verification
Wait 10 seconds, then verify:
```bash
openclaw gateway status
```
- If healthy, log resolution as auto-healed.
- If still failing, escalate alert (format below).

## 4) Alert format (if still failing)
Use HIGH priority format from alerting docs:

```text
🔴 Gateway uptime alert
service: openclaw-gateway
host: <hostname>
probe_failures: <n>
remediation: openclaw gateway restart
verification: FAILED
next_step: manual triage required
last_error: <stderr/status output>
time: <ISO-8601>
```

## 5) Safety guardrails (avoid restart loops)
- **Restart rate limit:** max **2 restarts per 30 minutes**.
- **Backoff:** 1st retry immediate after threshold; 2nd retry only after 5 minutes.
- **Loop breaker:** if verification fails after allowed retries, **stop auto-restarts** and alert.
- **State tracking:** persist failure/restart counters (timestamped) so counters survive script restarts.
- **No flapping reaction:** reset consecutive-failure counter only after 3 consecutive successful probes.
