import { describe, expect, it } from "vitest";
import { classifyAlpacaResponses } from "../../tools/proactive/alpaca-heartbeat";

describe("classifyAlpacaResponses", () => {
  it("recognizes target/account mismatch clearly", () => {
    const result = classifyAlpacaResponses({
      portfolioStatus: 503,
      portfolioBody: JSON.stringify({
        error: "alpaca account target mismatch: target=live actual=paper keys_path=/tmp/alpaca_keys.json",
        target_environment: "live",
        environment: "paper",
        keys_path: "/tmp/alpaca_keys.json",
        key_fingerprint: "abc123",
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.kind).toBe("target_mismatch");
    expect(result.title).toContain("target/account mismatch");
    expect(result.summary).toContain("target environment live");
  });

  it("returns parsed portfolio on success", () => {
    const result = classifyAlpacaResponses({
      portfolioStatus: 200,
      portfolioBody: JSON.stringify({ positions: [{ symbol: "NVDA" }] }),
    });

    expect(result.ok).toBe(true);
    expect(result.portfolio.positions[0].symbol).toBe("NVDA");
  });

  it("reports unreachable service separately", () => {
    const result = classifyAlpacaResponses({ requestError: "connect ECONNREFUSED 127.0.0.1:3033" });
    expect(result.ok).toBe(false);
    expect(result.kind).toBe("unreachable");
    expect(result.summary).toContain("ECONNREFUSED");
  });
});
