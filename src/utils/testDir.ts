import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { formatRunTimestamp } from "./time.ts";

const O_AGENTS_DIR = ".o-agents";
const TEST_DIR = "test";

let testRunDir: string | undefined;

export function getTestDir(): string {
  if (!testRunDir) {
    const timestamp = formatRunTimestamp();
    testRunDir = join(process.cwd(), O_AGENTS_DIR, TEST_DIR, timestamp);
    mkdirSync(testRunDir, { recursive: true });
  }
  return testRunDir;
}

export function cleanupTestBaseDir(): void {
  const testBaseDir = join(process.cwd(), O_AGENTS_DIR, TEST_DIR);
  rmSync(testBaseDir, { recursive: true, force: true });
}

export function createTestSubDir(prefix: string): string {
  const baseDir = getTestDir();
  return mkdtempSync(join(baseDir, `${prefix}-`));
}
