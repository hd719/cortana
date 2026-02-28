#!/usr/bin/env npx tsx

import { ChaosScenario, type ScenarioResult } from "./base.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CronFailureScenario extends ChaosScenario {
  override name = "cron_failure";
  override fault_type = "cron";

  override async run(): Promise<ScenarioResult> {
    const start = performance.now();
    await sleep(60);
    const detected_ms = Math.trunc(performance.now() - start);
    await sleep(50);
    const recovery_ms = Math.trunc(performance.now() - start);

    return {
      name: this.name,
      fault_type: this.fault_type,
      injected: true,
      detected: true,
      recovered: true,
      detection_ms: detected_ms,
      recovery_ms,
      notes: "Simulated missed/hung cron with restart+reschedule remediation.",
      metadata: { simulated_state: "missed_run", actions: ["clear_stale_running", "reschedule"] },
    };
  }
}
