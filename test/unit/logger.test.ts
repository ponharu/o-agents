import { expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { logger } from "../../src/utils/logger.ts";
import { createTestSubDir } from "../../src/utils/testDir.ts";

test("logger logs full prompt to file when console output is truncated", async () => {
  const tempDir = createTestSubDir("logger");
  const logPath = path.join(tempDir, "run.log");

  try {
    logger.logPath = logPath;
    const prompt = "prompt-".repeat(30);

    logger.logPrompt("Agent test prompt", prompt, 40);

    const content = await readFile(logPath, "utf8");

    expect(content).toContain("Agent test prompt (");
    expect(content).toContain(prompt);
  } finally {
    logger.logPath = undefined;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("logger runWithContext scopes output to extra log paths with prefix", async () => {
  const tempDir = createTestSubDir("logger");
  const logPath = path.join(tempDir, "run.log");
  const extraLogPath = path.join(tempDir, "workflow.log");

  try {
    logger.logPath = logPath;
    await logger.runWithContext({ extraLogPaths: [extraLogPath], prefix: "[run-1]" }, async () => {
      logger.info("hello from run");
    });

    const baseContent = await readFile(logPath, "utf8");
    const extraContent = await readFile(extraLogPath, "utf8");

    expect(baseContent).toContain("[run-1] hello from run");
    expect(extraContent).toContain("hello from run");
    expect(extraContent).not.toContain("[run-1]");
  } finally {
    logger.logPath = undefined;
    await rm(tempDir, { recursive: true, force: true });
  }
});
