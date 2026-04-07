#!/usr/bin/env -S npx tsx
import { buildGogEnv, runGogWithEnv } from "./gog-with-env.js";

export { buildGogEnv };

export function runCalendarEventsJson(args: string[], env: NodeJS.ProcessEnv = process.env, plistPath?: string) {
  return runGogWithEnv(args, env, plistPath);
}

export function main(argv = process.argv.slice(2)) {
  const result = runCalendarEventsJson(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
