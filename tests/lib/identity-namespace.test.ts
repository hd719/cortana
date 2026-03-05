import { describe, expect, it } from "vitest";

import {
  resolveAgentIdFromSessionKey,
  resolveNamespaceFilePath,
  resolveNamespaceForAgent,
  upsertBootstrapFile,
} from "../../tools/lib/identity-namespace";

describe("identity namespace resolution", () => {
  it("resolves namespace per agent", () => {
    const namespace = resolveNamespaceForAgent("researcher", {
      defaultNamespace: "main",
      namespaces: { researcher: "researcher", huragok: "huragok" },
    });

    expect(namespace).toBe("researcher");
    expect(resolveNamespaceFilePath("/repo", namespace, "SOUL.md")).toBe("/repo/identities/researcher/SOUL.md");
  });

  it("falls back to default namespace when mapping missing", () => {
    const namespace = resolveNamespaceForAgent("unknown-agent", {
      defaultNamespace: "main",
      namespaces: { researcher: "researcher" },
    });

    expect(namespace).toBe("main");
  });

  it("main default behavior is unchanged", () => {
    const namespace = resolveNamespaceForAgent("main", {
      defaultNamespace: "main",
      namespaces: { researcher: "researcher", huragok: "huragok" },
    });

    expect(namespace).toBe("main");
  });

  it("upserts namespace file without breaking existing fallback entries", () => {
    const files = [{ name: "SOUL.md", path: "/repo/SOUL.md", missing: false }];
    upsertBootstrapFile(files, {
      name: "SOUL.md",
      path: "/repo/identities/researcher/SOUL.md",
      content: "research soul",
    });

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("/repo/identities/researcher/SOUL.md");
    expect(files[0]?.missing).toBe(false);
  });

  it("parses agent id from session key", () => {
    expect(resolveAgentIdFromSessionKey("agent:huragok:thread-1")).toBe("huragok");
    expect(resolveAgentIdFromSessionKey("agent:main:main")).toBe("main");
    expect(resolveAgentIdFromSessionKey("weird")).toBe(null);
  });
});
