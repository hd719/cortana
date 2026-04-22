import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

const TEST_TEMP_ROOT = path.join(process.cwd(), "tmp", "test-artifacts");

export function createTestTempDir(prefix: string, trackedRoots: Set<string>): string {
  mkdirSync(TEST_TEMP_ROOT, { recursive: true });
  const root = mkdtempSync(path.join(TEST_TEMP_ROOT, prefix));
  trackedRoots.add(root);
  return root;
}

export function cleanupTestTempDirs(trackedRoots: Set<string>): void {
  for (const root of trackedRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  trackedRoots.clear();
}
