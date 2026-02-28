#!/usr/bin/env npx tsx
import { spawnSync } from "child_process";

async function main(): Promise<number> {
  const res = spawnSync("bird", ["check"], { encoding: "utf8" });
  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  if (output.includes("ok")) {
    return 0;
  }
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
