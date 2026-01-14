import { expect, test } from "bun:test";
import { runAgentBenchmarkCase, runCommand, TEST_TIMEOUT, WORKFLOW_SIMPLE_PATH } from "./utils.ts";

test(
  "agent-benchmark issue #4 e2e",
  async () => {
    await runAgentBenchmarkCase({
      issueRef: "https://github.com/exKAZUu/agent-benchmark/issues/4",
      workflowPath: WORKFLOW_SIMPLE_PATH,
      mainTool: "codex-cli",
      compareTools: ["claude-code"],
      validateRunOutput: (output) => {
        expect(output).toContain("Best PR:");
        expect(output).toContain("Selection reason:");
      },
      validateOutput: async (repoDir) => {
        const runResult = await runCommand(["bun", "run", "src/index.ts", "calc", "10", "%", "3"], {
          cwd: repoDir,
        });
        console.log(runResult.combined);

        expect(runResult.stdout.trim()).toBe("1");
        expect(runResult.exitCode).toBe(0);
      },
    });
  },
  { timeout: TEST_TIMEOUT },
);
