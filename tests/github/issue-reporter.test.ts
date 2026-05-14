import { describe, expect, it, vi } from "vitest";
import {
  buildIssueLabels,
  reportOperationalIssue,
  routeIssue,
  type GitHubIssueClient,
} from "../../tools/github/issue-reporter";

describe("GitHub issue reporter", () => {
  it("routes runtime and deployed service issues to cortana-external", () => {
    expect(
      routeIssue({
        title: "Schwab auth expired",
        summary: "Runtime service degraded and needs reauth",
        source: "market-data-monitor",
      }),
    ).toBe("cortana-foundry/cortana-external");
  });

  it("routes doctrine and cron policy issues to cortana by default", () => {
    expect(
      routeIssue({
        title: "Cron prompt drift",
        summary: "Agent behavior policy needs tightening",
        source: "doctor",
      }),
    ).toBe("cortana-foundry/cortana");
  });

  it("skips low-signal one-off warnings", () => {
    const result = reportOperationalIssue({
      title: "Transient warning",
      summary: "A one-off warning cleared on retry",
      source: "monitor",
    });

    expect(result.status).toBe("skipped");
  });

  it("supports dry-run issue creation without calling GitHub", () => {
    const client: GitHubIssueClient = { createIssue: vi.fn() };
    const result = reportOperationalIssue(
      {
        title: "Runtime service degraded",
        summary: "Mission Control health check failed after deployment",
        source: "qa",
        category: "qa-failure",
        severity: "critical",
      },
      { dryRun: true, client },
    );

    expect(result.status).toBe("dry-run");
    expect(result.repo).toBe("cortana-foundry/cortana-external");
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  it("creates high-signal issues through the injected client", () => {
    const client: GitHubIssueClient = {
      createIssue: vi.fn(() => ({ url: "https://github.com/cortana-foundry/cortana/issues/1" })),
    };
    const result = reportOperationalIssue(
      {
        title: "OAuth auth expired",
        summary: "Human action required for calendar credentials",
        source: "gog-oauth-refresh",
        category: "auth",
        severity: "critical",
      },
      { client },
    );

    expect(result.status).toBe("created");
    expect(client.createIssue).toHaveBeenCalledOnce();
  });

  it("reuses an existing open issue with the same title", () => {
    const client: GitHubIssueClient = {
      findOpenIssue: vi.fn(() => ({ url: "https://github.com/cortana-foundry/cortana/issues/2" })),
      createIssue: vi.fn(() => ({ url: "unused" })),
    };
    const result = reportOperationalIssue(
      {
        title: "Runtime service degraded",
        summary: "Mission Control degraded again",
        source: "monitor",
      },
      { client },
    );

    expect(result.status).toBe("existing");
    expect(client.createIssue).not.toHaveBeenCalled();
  });

  it("normalizes labels", () => {
    expect(buildIssueLabels({ title: "x", summary: "runtime degraded", source: "test", category: "Auth Required" })).toContain("auth-required");
  });
});
