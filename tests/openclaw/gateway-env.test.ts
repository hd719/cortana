import { describe, expect, it } from "vitest";
import { computePreservedGatewayEnv } from "../../tools/openclaw/gateway-env.ts";

describe("gateway env preservation", () => {
  it("prefers current shell env over existing plist values", () => {
    const env = computePreservedGatewayEnv(
      { GOG_KEYRING_PASSWORD: "from-shell" } as NodeJS.ProcessEnv,
      { GOG_KEYRING_PASSWORD: "from-plist" },
    );
    expect(env.GOG_KEYRING_PASSWORD).toBe("from-shell");
  });

  it("falls back to existing plist values when shell env is absent", () => {
    const env = computePreservedGatewayEnv(
      {} as NodeJS.ProcessEnv,
      { GOG_KEYRING_PASSWORD: "from-plist" },
    );
    expect(env.GOG_KEYRING_PASSWORD).toBe("from-plist");
  });

  it("drops empty values", () => {
    const env = computePreservedGatewayEnv(
      { GOG_KEYRING_PASSWORD: "   " } as NodeJS.ProcessEnv,
      {},
    );
    expect(env.GOG_KEYRING_PASSWORD).toBeUndefined();
  });
});
