import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  IDENTITY_NAMESPACE_FILES,
  resolveAgentIdFromSessionKey,
  resolveDurableMemoryTargets,
  resolveNamespaceFilePath,
  resolveNamespaceForAgent,
  upsertBootstrapFile,
} from "../../tools/lib/identity-namespace";

describe("identity namespace resolution", () => {
  it("includes VOICE.md in namespaced identity files", () => {
    expect(IDENTITY_NAMESPACE_FILES).toContain("VOICE.md");
  });

  it("resolves namespace per agent", () => {
    const namespace = resolveNamespaceForAgent("monitor", {
      defaultNamespace: "main",
      namespaces: { monitor: "monitor", spartan: "spartan" },
    });

    expect(namespace).toBe("monitor");
    expect(resolveNamespaceFilePath("/repo", namespace, "SOUL.md")).toBe("/repo/identities/monitor/SOUL.md");
  });

  it("falls back to default namespace when mapping missing", () => {
    const namespace = resolveNamespaceForAgent("unknown-agent", {
      defaultNamespace: "main",
      namespaces: { monitor: "monitor" },
    });

    expect(namespace).toBe("main");
  });

  it("main default behavior is unchanged", () => {
    const namespace = resolveNamespaceForAgent("main", {
      defaultNamespace: "main",
      namespaces: { monitor: "monitor", spartan: "spartan" },
    });

    expect(namespace).toBe("main");
  });

  it("upserts namespace file without breaking existing fallback entries", () => {
    const files = [{ name: "SOUL.md", path: "/repo/SOUL.md", missing: false }];
    upsertBootstrapFile(files, {
      name: "SOUL.md",
      path: "/repo/identities/monitor/SOUL.md",
      content: "research soul",
    });

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("/repo/identities/monitor/SOUL.md");
    expect(files[0]?.missing).toBe(false);
  });

  it("parses agent id from session key", () => {
    expect(resolveAgentIdFromSessionKey("agent:spartan:thread-1")).toBe("spartan");
    expect(resolveAgentIdFromSessionKey("agent:main:main")).toBe("main");
    expect(resolveAgentIdFromSessionKey("weird")).toBe(null);
  });

  it("resolves monitor durable memory targets when namespace paths exist", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "identity-ns-test-"));
    fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "config", "identity-namespaces.json"),
      JSON.stringify(
        {
          defaultNamespace: "main",
          namespaces: { main: "main", monitor: "monitor", spartan: "spartan" },
        },
        null,
        2,
      ),
      "utf8",
    );

    const nsDir = path.join(workspace, "identities", "monitor");
    fs.mkdirSync(path.join(nsDir, "memory"), { recursive: true });
    fs.writeFileSync(path.join(nsDir, "MEMORY.md"), "# Monitor memory\n", "utf8");

    const result = resolveDurableMemoryTargets({ workspaceDir: workspace, agentId: "monitor" });
    expect(result.namespace).toBe("monitor");
    expect(result.usedFallback).toBe(false);
    expect(result.memoryFilePath).toBe(path.join(workspace, "identities", "monitor", "MEMORY.md"));
    expect(result.memoryDirPath).toBe(path.join(workspace, "identities", "monitor", "memory"));
  });

  it("falls back to main durable memory targets with warning when namespace paths are missing", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "identity-ns-test-"));
    fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "config", "identity-namespaces.json"),
      JSON.stringify(
        {
          defaultNamespace: "main",
          namespaces: { main: "main", monitor: "monitor", spartan: "spartan" },
        },
        null,
        2,
      ),
      "utf8",
    );

    const warnings: string[] = [];
    const result = resolveDurableMemoryTargets({
      workspaceDir: workspace,
      agentId: "spartan",
      warn: (message) => warnings.push(message),
    });

    expect(result.namespace).toBe("spartan");
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
