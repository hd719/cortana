#!/usr/bin/env npx tsx

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChaosScenario, type ScenarioResult } from "./base.js";

export class MemoryCorruptionScenario extends ChaosScenario {
  override name = "memory_corruption";
  override fault_type = "memory_state";

  override async run(): Promise<ScenarioResult> {
    const start = performance.now();
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "chaos-memory-"));
    const stateFile = path.join(tmpdir, "heartbeat-state.json");

    fs.writeFileSync(stateFile, "{invalid_json", "utf8");

    let detected = false;
    try {
      JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
      detected = true;
    }

    const detected_ms = Math.trunc(performance.now() - start);

    fs.writeFileSync(
      stateFile,
      JSON.stringify({ lastChecks: {}, lastRemediationAt: Math.trunc(Date.now() / 1000) }),
      "utf8"
    );
    const recovery_ms = Math.trunc(performance.now() - start);

    return {
      name: this.name,
      fault_type: this.fault_type,
      injected: true,
      detected,
      recovered: true,
      detection_ms: detected_ms,
      recovery_ms,
      notes: "Corrupt state file repaired in isolated temp sandbox.",
      metadata: { sandbox_file: stateFile },
    };
  }
}
