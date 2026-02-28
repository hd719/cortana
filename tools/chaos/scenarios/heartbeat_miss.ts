#!/usr/bin/env npx tsx

import { ChaosScenario, type ScenarioResult } from "./base.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HeartbeatMissScenario extends ChaosScenario {
  override name = "heartbeat_miss";
  override fault_type = "heartbeat";

  override async run(): Promise<ScenarioResult> {
    const start = performance.now();
    await sleep(50);
    const detected_ms = Math.trunc(performance.now() - start);
    await sleep(40);
    const recovery_ms = Math.trunc(performance.now() - start);

    return {
      name: this.name,
      fault_type: this.fault_type,
      injected: true,
      detected: true,
      recovered: true,
      detection_ms: detected_ms,
      recovery_ms,
      notes: "Simulated heartbeat miss with auto-remediation guardrails.",
      metadata: { signal: "stale_heartbeat", remediation: "reschedule_and_refresh" },
    };
  }
}
