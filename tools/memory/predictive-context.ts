#!/usr/bin/env npx tsx
import { spawnSync } from "child_process";
import { resolveRepoPath } from "../lib/paths.js";

function usage(): void {
  process.stderr.write("Usage: tools/memory/predictive-context.sh \"<topic or query>\" [max_results]\n");
}

function isCommandAvailable(cmd: string): boolean {
  const res = spawnSync("command -v " + cmd, {
    shell: true,
    stdio: "ignore",
  });
  return res.status === 0;
}

function flattenText(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) {
    return node.map((item) => flattenText(item)).filter(Boolean).join(" ");
  }
  if (typeof node === "object") {
    const dict = node as Record<string, unknown>;
    const preferred = ["snippet", "content", "text", "summary", "chunk", "body", "value", "message"];
    for (const key of preferred) {
      const value = dict[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
    try {
      return JSON.stringify(dict);
    } catch {
      return String(dict);
    }
  }
  return String(node);
}

function sourceLabel(item: unknown): string {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const dict = item as Record<string, unknown>;
    for (const key of ["source", "file", "path", "id", "title"]) {
      const value = dict[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    const meta = dict.metadata;
    if (meta && typeof meta === "object" && !Array.isArray(meta)) {
      const metaDict = meta as Record<string, unknown>;
      for (const key of ["source", "path", "title"]) {
        const value = metaDict[key];
        if (typeof value === "string" && value.trim()) {
          return value.trim();
        }
      }
    }
  }
  return "memory";
}

function scoreValue(item: unknown): number | null {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const dict = item as Record<string, unknown>;
    for (const key of ["score", "similarity", "relevance"]) {
      const value = dict[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
  }
  return null;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length < 1) {
    usage();
    return 1;
  }

  const query = argv[0] ?? "";
  const maxResults = Number(argv[1] ?? "5");

  if (!isCommandAvailable("openclaw")) {
    process.stderr.write("Error: openclaw CLI not found in PATH\n");
    return 1;
  }

  const scriptPath = resolveRepoPath("tools/memory/safe-memory-search.py");
  const searchRes = spawnSync("python3", [scriptPath, query, "--json", "--max-results", String(maxResults)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let rawJson = (searchRes.stdout ?? "").toString();
  if (!rawJson.trim()) {
    process.stdout.write(`## Predictive Context: ${query}\n\n_No related memory found._\n`);
    return 0;
  }

  const match = rawJson.search(/[\[{]/);
  if (match >= 0) {
    rawJson = rawJson.slice(match);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawJson);
  } catch {
    process.stdout.write(`## Predictive Context: ${query}\n\n_No related memory found._\n`);
    return 0;
  }

  let items: unknown[] = [];
  if (Array.isArray(payload)) {
    items = payload;
  } else if (payload && typeof payload === "object") {
    const dict = payload as Record<string, unknown>;
    for (const key of ["results", "items", "matches", "data"]) {
      const value = dict[key];
      if (Array.isArray(value)) {
        items = value;
        break;
      }
    }
  }

  const cleaned: Array<{ text: string; source: string; score: number | null }> = [];
  for (const item of items) {
    let text = flattenText(item);
    text = text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.length > 420) {
      text = text.slice(0, 417).trimEnd() + "...";
    }
    cleaned.push({
      text,
      source: sourceLabel(item),
      score: scoreValue(item),
    });
  }

  if (cleaned.length === 0) {
    process.stdout.write(`## Predictive Context: ${query}\n\n_No related memory found._\n`);
    return 0;
  }

  const limited = cleaned.slice(0, maxResults);
  process.stdout.write(`## Predictive Context: ${query}\n\n`);
  limited.forEach((row, idx) => {
    const scoreText = typeof row.score === "number" ? ` (score: ${row.score.toFixed(3)})` : "";
    process.stdout.write(`${idx + 1}. **${row.source}**${scoreText}\n`);
    process.stdout.write(`   - ${row.text}\n`);
  });
  process.stdout.write(
    "\n_Use this context to ground the next response in prior decisions, research, and ongoing threads._\n"
  );

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
