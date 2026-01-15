import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { RESULT_DELIVERY_INSTRUCTION } from "../../src/agent/prompt.ts";
import { runNonInteractiveAgent } from "../../src/agent/workflowRunner.ts";
import { logger } from "../../src/utils/logger.ts";
import { createTestSubDir } from "../../src/utils/testDir.ts";
import { TEST_TIMEOUT } from "./utils.ts";

test(
  "gemini-cli e2e: logs interactive output",
  async () => {
    const testDir = createTestSubDir("gemini-cli-logging");
    const logPath = path.join(testDir, "gemini-cli.log");

    await logger.runWithContext({ logPath }, async () => {
      await runNonInteractiveAgent({
        tool: "gemini-cli",
        cwd: process.cwd(),
        prompt: [
          "Print exactly the single word Hi on its own line.",
          "Then follow the response delivery instruction and write DONE to the response file.",
          RESULT_DELIVERY_INSTRUCTION,
        ].join("\n"),
      });
    });

    const logContents = await readFile(logPath, "utf8");
    expect(logContents).toContain("Hi");
  },
  { timeout: TEST_TIMEOUT },
);
