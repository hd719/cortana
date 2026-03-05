import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("ingest_unified_memory process lifecycle", () => {
  it("uses ChildProcess.kill instead of terminate", () => {
    const src = readFileSync("tools/memory/ingest_unified_memory.ts", "utf8");
    expect(src).not.toContain("this.proc.terminate(");
    expect(src).toContain("this.proc.kill(\"SIGTERM\")");
  });
});
