import { expect, test } from "bun:test";
import runWorkflow from "../../o-agents/workflowInternalTest.ts";
import type { IssueData } from "../../src/types.ts";
import { runAgentBenchmarkCase, runCommand, TEST_TIMEOUT, WORKFLOW_SIMPLE_PATH } from "./utils.ts";

test.skip(
  "internal workflow e2e: octofriend",
  async () => {
    const exitCode = await runInternalWorkflow("octofriend");
    expect(exitCode).toBe(0);
  },
  { timeout: TEST_TIMEOUT },
);

const issueData: IssueData = {
  title: "Internal workflow smoke test",
  body: "Confirm agent can post results to the local callback server.",
  url: "https://example.invalid/issues/0",
  comments: [],
};

async function runInternalWorkflow(tool: "octofriend"): Promise<number> {
  return runWorkflow({
    tool,
    issueData,
    baseBranch: "main",
    headBranch: "internal-test",
    cwd: process.cwd(),
  });
}

test.skip(
  "agent-benchmark issue #1 e2e",
  async () => {
    await runAgentBenchmarkCase({
      issueRef: "#1",
      workflowPath: WORKFLOW_SIMPLE_PATH,
      mainTool: "octofriend",
      validateOutput: async (repoDir) => {
        const runResult = await runCommand(["bun", "run", "src/index.ts", "hello"], {
          cwd: repoDir,
          throwOnError: false,
        });
        console.log(runResult.combined);

        expect(runResult.stdout).toContain("Hello, World!");
        expect(runResult.exitCode).toBe(0);
      },
    });
  },
  { timeout: TEST_TIMEOUT },
);
