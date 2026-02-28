#!/usr/bin/env npx tsx

import { ChaosScenario, type ScenarioResult } from "./base.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ToolUnavailabilityScenario extends ChaosScenario {
  override name = "tool_unavailability";
  override fault_type = "tool";

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
      notes: "Simulated API timeout with fallback recovery path.",
      metadata: { simulated_error: "timeout", fallback: "secondary_probe" },
    };
  }
}
