#!/usr/bin/env npx tsx

export type ScenarioResult = {
  name: string;
  fault_type: string;
  injected: boolean;
  detected: boolean;
  recovered: boolean;
  detection_ms: number;
  recovery_ms: number;
  notes?: string;
  metadata?: Record<string, unknown>;
};

export abstract class ChaosScenario {
  name = "base";
  fault_type = "unknown";

  abstract run(): Promise<ScenarioResult>;
}

export function serializeResults(results: ScenarioResult[]): Array<Record<string, unknown>> {
  return results.map((r) => ({
    name: r.name,
    fault_type: r.fault_type,
    injected: r.injected,
    detected: r.detected,
    recovered: r.recovered,
    detection_ms: r.detection_ms,
    recovery_ms: r.recovery_ms,
    notes: r.notes ?? "",
    metadata: r.metadata ?? {},
  }));
}
