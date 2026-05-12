import { describe, expect, it } from "vitest";
import { evaluateMainClean, parseAheadBehindCounts } from "../../tools/release/done-gates-lib";

describe("done-gates-lib", () => {
  it("parses ahead/behind counts from git output", () => {
    expect(parseAheadBehindCounts("2 3\n")).toEqual({ ahead: 3, behind: 2 });
  });

  it("throws on malformed ahead/behind output", () => {
    expect(() => parseAheadBehindCounts("nope")).toThrow(/unable to parse/);
  });

  it("passes when working tree is clean and main is in sync", () => {
    const result = evaluateMainClean("", "0 0");
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails when working tree has changes or main diverges", () => {
    const result = evaluateMainClean(" M tools/release/done-gates-lib.ts\n", "1 2");
    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual([
      "working tree is dirty (commit/stash/discard local changes)",
      "local main is ahead of origin/main by 2 commit(s)",
      "local main is behind origin/main by 1 commit(s)",
    ]);
  });
});
