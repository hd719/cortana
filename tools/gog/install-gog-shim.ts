#!/usr/bin/env npx tsx
import fs from "node:fs";
import path from "node:path";
import { sourceRepoRoot } from "../lib/paths.js";

export function buildGogShimScript(repoRoot = sourceRepoRoot()): string {
  return `#!/usr/bin/env bash
set -euo pipefail
REAL_GOG_BIN="\${OPENCLAW_REAL_GOG_BIN:-/opt/homebrew/bin/gog}"
if [[ ! -x "$REAL_GOG_BIN" ]]; then
  REAL_GOG_BIN="/usr/local/bin/gog"
fi
exec env OPENCLAW_REAL_GOG_BIN="$REAL_GOG_BIN" npx tsx ${JSON.stringify(path.join(repoRoot, "tools", "gog", "gog-with-env.ts"))} "$@"
`;
}

export function installGogShim(shimPath: string, repoRoot = sourceRepoRoot()): { changed: boolean } {
  const content = buildGogShimScript(repoRoot);
  const current = fs.existsSync(shimPath) ? fs.readFileSync(shimPath, "utf8") : null;
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  if (current !== content) {
    fs.writeFileSync(shimPath, content, { mode: 0o755 });
  }
  fs.chmodSync(shimPath, 0o755);
  return { changed: current !== content };
}

function parseArgs(argv: string[]) {
  const args = {
    shimPath: path.join(process.env.HOME ?? "", ".openclaw", "bin", "gog"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--path") args.shimPath = argv[++i]!;
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const result = installGogShim(args.shimPath);
  console.log(result.changed ? "SYNCED" : "NO_CHANGE");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
