import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { materializeDailyMemory } from "../../tools/memory/materialize-daily-memory.ts";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "daily-memory-"));
  tempRoots.push(root);
  return root;
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("materializeDailyMemory", () => {
  it("creates a canonical daily file from eligible live session messages and artifacts", () => {
    const root = makeTempRoot();
    const repoRoot = path.join(root, "repo");
    const stateRoot = path.join(root, "state");

    writeJsonl(path.join(stateRoot, "agents", "main", "sessions", "abc.jsonl"), [
      { type: "session", timestamp: "2026-05-05T12:00:00.000Z" },
      {
        type: "message",
        timestamp: "2026-05-05T12:01:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Track Morocco flights for two business seats." }] },
      },
      {
        type: "message",
        timestamp: "2026-05-05T12:02:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "I will watch Google Flights plus open fare feeds." }] },
      },
      {
        type: "message",
        timestamp: "2026-05-05T12:03:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "[OpenClaw heartbeat poll]" }] },
      },
    ]);
    fs.mkdirSync(path.join(repoRoot, "memory", "dreaming", "light"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "memory", "dreaming", "light", "2026-05-05.md"), "dream", "utf8");

    const [result] = materializeDailyMemory({
      repoRoot,
      externalRepoRoot: path.join(root, "external"),
      stateRoot,
      logRoot: path.join(root, "logs"),
      dates: ["2026-05-05"],
    });

    expect(result.sessionMessageCount).toBe(2);
    expect(result.artifactCount).toBe(1);
    const written = fs.readFileSync(path.join(repoRoot, "memory", "2026-05-05.md"), "utf8");
    expect(written).toContain("# Daily Memory - 2026-05-05");
    expect(written).toContain("Track Morocco flights for two business seats.");
    expect(written).toContain("I will watch Google Flights plus open fare feeds.");
    expect(written).not.toContain("[OpenClaw heartbeat poll]");
    expect(written).toContain("memory/dreaming/light/2026-05-05.md");
  });

  it("preserves existing manual notes while replacing only the managed block", () => {
    const root = makeTempRoot();
    const repoRoot = path.join(root, "repo");
    const stateRoot = path.join(root, "state");
    const dailyPath = path.join(repoRoot, "memory", "2026-05-05.md");
    fs.mkdirSync(path.dirname(dailyPath), { recursive: true });
    fs.writeFileSync(
      dailyPath,
      [
        "# Daily Memory - 2026-05-05",
        "",
        "- Manual note stays.",
        "",
        "<!-- cortana:daily-memory:start -->",
        "old managed content",
        "<!-- cortana:daily-memory:end -->",
        "",
      ].join("\n"),
      "utf8"
    );
    writeJsonl(path.join(stateRoot, "agents", "monitor", "sessions", "def.jsonl"), [
      {
        type: "message",
        timestamp: "2026-05-05T13:00:00.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Cron health checked cleanly." }] },
      },
    ]);

    materializeDailyMemory({
      repoRoot,
      externalRepoRoot: path.join(root, "external"),
      stateRoot,
      logRoot: path.join(root, "logs"),
      dates: ["2026-05-05"],
    });

    const written = fs.readFileSync(dailyPath, "utf8");
    expect(written).toContain("- Manual note stays.");
    expect(written).toContain("Cron health checked cleanly.");
    expect(written).not.toContain("old managed content");
  });

  it("redacts common token-shaped secrets from session text", () => {
    const root = makeTempRoot();
    const repoRoot = path.join(root, "repo");
    const stateRoot = path.join(root, "state");
    writeJsonl(path.join(stateRoot, "agents", "main", "sessions", "ghi.jsonl"), [
      {
        type: "message",
        timestamp: "2026-05-05T14:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "token sk-abcdefghijklmnopqrstuvwxyz123456" }] },
      },
    ]);

    materializeDailyMemory({
      repoRoot,
      externalRepoRoot: path.join(root, "external"),
      stateRoot,
      logRoot: path.join(root, "logs"),
      dates: ["2026-05-05"],
    });

    const written = fs.readFileSync(path.join(repoRoot, "memory", "2026-05-05.md"), "utf8");
    expect(written).toContain("[redacted-token]");
    expect(written).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  it("adds git commits and gateway log signals to the managed block", () => {
    const root = makeTempRoot();
    const repoRoot = path.join(root, "repo");
    const externalRepoRoot = path.join(root, "external");
    const stateRoot = path.join(root, "state");
    const logRoot = path.join(root, "logs");

    fs.mkdirSync(repoRoot, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
    fs.writeFileSync(path.join(repoRoot, "README.md"), "hello", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: repoRoot });
    execFileSync("git", ["commit", "-m", "Fix memory backfill"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-05-05T10:00:00-04:00",
        GIT_COMMITTER_DATE: "2026-05-05T10:00:00-04:00",
      },
      stdio: "ignore",
    });

    fs.mkdirSync(externalRepoRoot, { recursive: true });
    execFileSync("git", ["init"], { cwd: externalRepoRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: externalRepoRoot });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: externalRepoRoot });
    fs.writeFileSync(path.join(externalRepoRoot, "README.md"), "external", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: externalRepoRoot });
    execFileSync("git", ["commit", "-m", "Repair Mission Control memory view"], {
      cwd: externalRepoRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2026-05-05T11:00:00-04:00",
        GIT_COMMITTER_DATE: "2026-05-05T11:00:00-04:00",
      },
      stdio: "ignore",
    });

    fs.mkdirSync(logRoot, { recursive: true });
    fs.writeFileSync(
      path.join(logRoot, "openclaw-2026-05-05.log"),
      `${JSON.stringify({
        time: "2026-05-05T12:00:00-04:00",
        message: "memory embeddings rate limited; retrying in 581ms",
        _meta: { logLevelName: "WARN" },
      })}\n`,
      "utf8"
    );

    materializeDailyMemory({
      repoRoot,
      externalRepoRoot,
      stateRoot,
      logRoot,
      dates: ["2026-05-05"],
    });

    const written = fs.readFileSync(path.join(repoRoot, "memory", "2026-05-05.md"), "utf8");
    expect(written).toContain("## Git Activity");
    expect(written).toContain("[cortana]");
    expect(written).toContain("Fix memory backfill");
    expect(written).toContain("[cortana-external]");
    expect(written).toContain("Repair Mission Control memory view");
    expect(written).toContain("## Operational Log Signals");
    expect(written).toContain("memory embeddings rate limited");
  });
});
