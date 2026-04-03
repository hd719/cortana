import { describe, expect, it } from "vitest";
import { buildGogEnv } from "../../tools/gog/calendar-events-json.ts";

describe("buildGogEnv", () => {
  it("prefers the current env password when already present", () => {
    const env = buildGogEnv(
      { GOG_KEYRING_PASSWORD: "from-shell" } as NodeJS.ProcessEnv,
      { GOG_KEYRING_PASSWORD: "from-plist" },
    );
    expect(env.GOG_KEYRING_PASSWORD).toBe("from-shell");
  });

  it("inherits the gateway plist password when current env is headless", () => {
    const env = buildGogEnv(
      {} as NodeJS.ProcessEnv,
      { GOG_KEYRING_PASSWORD: "from-plist" },
    );
    expect(env.GOG_KEYRING_PASSWORD).toBe("from-plist");
  });

  it("leaves env unchanged when no password is available anywhere", () => {
    const env = buildGogEnv({ PATH: "/usr/bin" } as NodeJS.ProcessEnv, {});
    expect(env.GOG_KEYRING_PASSWORD).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});
