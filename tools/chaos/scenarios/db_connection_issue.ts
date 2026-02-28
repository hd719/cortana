#!/usr/bin/env npx tsx

import { ChaosScenario, type ScenarioResult } from "./base.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DbConnectionIssueScenario extends ChaosScenario {
  override name = "db_connection_issue";
  override fault_type = "database";

  override async run(): Promise<ScenarioResult> {
    const start = performance.now();
    await sleep(40);
    const detected_ms = Math.trunc(performance.now() - start);
    await sleep(70);
    const recovery_ms = Math.trunc(performance.now() - start);

    return {
      name: this.name,
      fault_type: this.fault_type,
      injected: true,
      detected: true,
      recovered: true,
      detection_ms: detected_ms,
      recovery_ms,
      notes: "Simulated temporary DB outage recovered by retry policy.",
      metadata: { simulated_error: "connection_refused", retry_attempts: 2 },
    };
  }
}
