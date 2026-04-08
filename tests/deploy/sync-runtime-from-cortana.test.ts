import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runOrThrow(cmd: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(
      [`command failed: ${cmd} ${args.join(" ")}`, result.stdout, result.stderr].filter(Boolean).join("\n"),
    );
  }

  return result;
}

function git(cwd: string, ...args: string[]) {
  return runOrThrow("git", args, cwd).stdout.trim();
}

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-deploy-"));
  const remote = path.join(root, "remote.git");
  const source = path.join(root, "source");
  const runtime = path.join(root, "runtime");
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");

  runOrThrow("git", ["init", "--bare", remote]);
  runOrThrow("git", ["clone", remote, source]);
  git(source, "checkout", "-b", "main");
  git(source, "config", "user.name", "Test User");
  git(source, "config", "user.email", "test@example.com");

  writeJson(path.join(source, "config", "cron", "jobs.json"), {
    jobs: [{ id: "brief", name: "Initial Brief", schedule: { expr: "0 6 * * *" }, enabled: true }],
  });
  writeJson(path.join(source, "config", "openclaw.json"), {
    models: {
      providers: {
        openai: { apiKey: "__OPENAI_API_KEY__" },
      },
    },
    channels: {
      telegram: {
        accounts: {
          default: { botToken: "__TELEGRAM_BOT_TOKEN__" },
        },
      },
    },
    gateway: {
      auth: { token: "__GATEWAY_TOKEN__" },
    },
  });
  writeJson(path.join(source, "config", "system-routing.json"), {
    telegram: {
      approvals: {
        accountId: "default",
        chatId: "8171372724",
      },
    },
  });
  fs.mkdirSync(path.join(source, "skills", "gog"), { recursive: true });
  fs.writeFileSync(path.join(source, "skills", "gog", "SKILL.md"), "# Gog skill fixture\n", "utf8");
  fs.writeFileSync(path.join(source, "README.md"), "source v1\n", "utf8");
  git(
    source,
    "add",
    "README.md",
    "config/cron/jobs.json",
    "config/openclaw.json",
    "config/system-routing.json",
    "skills/gog/SKILL.md",
  );
  git(source, "commit", "-m", "initial");
  git(source, "push", "-u", "origin", "main");

  runOrThrow("git", ["clone", "--branch", "main", remote, runtime]);

  writeJson(path.join(home, ".openclaw", "cron", "jobs.json"), {
    jobs: [{ id: "brief", name: "Initial Brief", state: { nextRunAtMs: 123 } }],
  });

  fs.mkdirSync(bin, { recursive: true });
  const openclaw = path.join(bin, "openclaw");
  fs.writeFileSync(
    openclaw,
    "#!/usr/bin/env bash\nif [[ \"$1 $2 $3\" == \"gateway status --no-probe\" ]] || [[ \"$1 $2\" == \"gateway status\" ]]; then\n  echo \"state = running\"\n  exit 0\nfi\nexit 0\n",
    "utf8",
  );
  fs.chmodSync(openclaw, 0o755);

  return { root, remote, source, runtime, home, bin };
}

describe("sync-runtime-from-cortana.sh", () => {
  const script = path.resolve("tools/deploy/sync-runtime-from-cortana.sh");

  it("migrates the legacy runtime checkout into a shim and syncs repo cron config into runtime state", () => {
    const fixture = makeFixture();

    fs.writeFileSync(path.join(fixture.source, "README.md"), "source v2\n", "utf8");
    writeJson(path.join(fixture.source, "config", "cron", "jobs.json"), {
      jobs: [{ id: "brief", name: "Deployed Brief", schedule: { expr: "0 6 * * *" }, enabled: true }],
    });
    git(fixture.source, "add", "README.md", "config/cron/jobs.json");
    git(fixture.source, "commit", "-m", "deployable change");
    git(fixture.source, "push", "origin", "main");

    const previousRuntimeCommit = git(fixture.runtime, "rev-parse", "HEAD");
    const result = runOrThrow(
      "bash",
      [script, "--source-repo", fixture.source, "--runtime-repo", fixture.runtime, "--runtime-home", fixture.home],
      process.cwd(),
      { HOME: fixture.home, PATH: `${fixture.bin}:${process.env.PATH}`, CORTANA_SOURCE_REPO: fixture.source },
    );

    const sourceHead = git(fixture.source, "rev-parse", "HEAD");
    expect(fs.lstatSync(fixture.runtime).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(fixture.runtime)).toBe(fs.realpathSync(fixture.source));
    expect(result.stdout).toContain("Runtime deploy complete");

    const runtimeCron = JSON.parse(fs.readFileSync(path.join(fixture.home, ".openclaw", "cron", "jobs.json"), "utf8")) as {
      jobs: Array<{ name: string; state?: { nextRunAtMs?: number } }>;
    };
    expect(runtimeCron.jobs[0].name).toBe("Deployed Brief");
    expect(runtimeCron.jobs[0].state?.nextRunAtMs).toBe(123);

    const stateFile = JSON.parse(
      fs.readFileSync(path.join(fixture.home, ".openclaw", "state", "runtime-deploy.json"), "utf8"),
    ) as { previousCompatCommit: string; deployedCommit: string; mode: string };
    expect(stateFile.mode).toBe("compat_shim");
    expect(stateFile.previousCompatCommit).toBe(previousRuntimeCommit);
    expect(stateFile.deployedCommit).toBe(sourceHead);
  });

  it("refuses to migrate a dirty legacy runtime repo", () => {
    const fixture = makeFixture();
    fs.writeFileSync(path.join(fixture.runtime, "README.md"), "runtime dirty\n", "utf8");

    const result = spawnSync(
      "bash",
      [script, "--source-repo", fixture.source, "--runtime-repo", fixture.runtime, "--runtime-home", fixture.home],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: fixture.home,
          PATH: `${fixture.bin}:${process.env.PATH}`,
          CORTANA_SOURCE_REPO: fixture.source,
        },
        encoding: "utf8",
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("compat repo has local changes");
  });
});
