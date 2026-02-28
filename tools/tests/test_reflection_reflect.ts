#!/usr/bin/env npx tsx

async function main(): Promise<void> {
  // Placeholder for legacy pytest wrapper. Intentionally no-op.
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
