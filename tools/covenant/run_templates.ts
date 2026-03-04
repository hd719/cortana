#!/usr/bin/env tsx

type RunTemplate = {
  id: string;
  title: string;
  labelPrefix: string;
  objective: string;
  checklist: string[];
};

const TEMPLATES: Record<string, RunTemplate> = {
  "pr-review": {
    id: "pr-review",
    title: "PR Review",
    labelPrefix: "reviewer",
    objective: "Review a pull request for correctness, risk, and merge readiness.",
    checklist: [
      "Read PR summary and diff hotspots",
      "Run or inspect relevant tests",
      "Flag blockers, nits, and merge recommendation",
    ],
  },
  "fix-test": {
    id: "fix-test",
    title: "Fix + Test",
    labelPrefix: "huragok",
    objective: "Implement a scoped fix and prove it with targeted tests.",
    checklist: [
      "Reproduce issue quickly",
      "Implement minimal fix",
      "Run focused tests and summarize confidence",
    ],
  },
  "docs-update": {
    id: "docs-update",
    title: "Docs Update",
    labelPrefix: "librarian",
    objective: "Update docs for clarity, correctness, and operator usability.",
    checklist: [
      "Identify stale/missing sections",
      "Apply concise edits with examples",
      "Include verification notes and next actions",
    ],
  },
};

export function listTemplates(): RunTemplate[] {
  return Object.values(TEMPLATES);
}

export function getTemplate(id: string): RunTemplate {
  const key = id.trim().toLowerCase();
  const template = TEMPLATES[key];
  if (!template) {
    throw new Error(`Unknown template: ${id}`);
  }
  return template;
}

export function buildTemplatePrompt(id: string, task: string): string {
  const template = getTemplate(id);
  const trimmedTask = task.trim();
  if (!trimmedTask) {
    throw new Error("Task text is required");
  }
  return [
    `Template: ${template.title} (${template.id})`,
    `Objective: ${template.objective}`,
    `Task: ${trimmedTask}`,
    "Execution checklist:",
    ...template.checklist.map((item, idx) => `${idx + 1}. ${item}`),
  ].join("\n");
}

if (require.main === module) {
  const [, , cmd, arg1, ...rest] = process.argv;
  try {
    if (cmd === "list") {
      console.log(JSON.stringify(listTemplates(), null, 2));
      process.exit(0);
    }
    if (cmd === "prompt") {
      const task = rest.join(" ");
      console.log(buildTemplatePrompt(arg1 ?? "", task));
      process.exit(0);
    }
    console.error("Usage: run_templates.ts list | prompt <template-id> <task>");
    process.exit(2);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
