import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveAgentIdFromSessionKey,
  resolveDurableMemoryTargets,
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

  it("resolves researcher durable memory targets when namespace paths exist", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "identity-ns-test-"));
    fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "config", "identity-namespaces.json"),
      JSON.stringify(
        {
          defaultNamespace: "main",
          namespaces: { main: "main", researcher: "researcher", huragok: "huragok" },
        },
        null,
        2,
      ),
      "utf8",
    );

    const nsDir = path.join(workspace, "identities", "researcher");
    fs.mkdirSync(path.join(nsDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(nsDir, "MEMORY.md"), "# Researcher memory\n", "utf8");

    const result = resolveDurableMemoryTargets({ workspaceDir: workspace, agentId: "researcher" });
    expect(result.namespace).toBe("researcher");
    expect(result.usedFallback).toBe(false);
    expect(result.memoryFilePath).toBe(path.join(workspace, "identities", "researcher", "MEMORY.md"));
    expect(result.memoryDirPath).toBe(path.join(workspace, "identities", "researcher", "memory"));
  });

  it("falls back to main durable memory targets with warning when namespace paths are missing", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "identity-ns-test-"));
    fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "config", "identity-namespaces.json"),
      JSON.stringify(
        {
          defaultNamespace: "main",
          namespaces: { main: "main", researcher: "researcher", huragok: "huragok" },
        },
        null,
        2,
      ),
      "utf8",
    );

    const warnings: string[] = [];
    const result = resolveDurableMemoryTargets({
      workspaceDir: workspace,
      agentId: "huragok",
      warn: (message) => warnings.push(message),
    });

    expect(result.namespace).toBe("huragok");
    expect(result.usedFallback).toBe(true);
    expect(result.memoryFilePath).toBe(path.join(workspace, "MEMORY.md"));
    expect(result.memoryDirPath).toBe(path.join(workspace, "memory"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("falling back to main memory targets");
  });

  it("keeps main durable memory targets unchanged", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "identity-ns-test-"));
    fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "config", "identity-namespaces.json"),
      JSON.stringify({ defaultNamespace: "main", namespaces: { main: "main" } }, null, 2),
      "utf8",
    );

    const result = resolveDurableMemoryTargets({ workspaceDir: workspace, agentId: "main" });
    expect(result.namespace).toBe("main");
    expect(result.usedFallback).toBe(false);
    expect(result.memoryFilePath).toBe(path.join(workspace, "MEMORY.md"));
    expect(result.memoryDirPath).toBe(path.join(workspace, "memory"));
  });
});
