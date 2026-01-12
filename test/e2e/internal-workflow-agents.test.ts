import { expect, test } from "bun:test";

import type { AgentTool, IssueData } from "../../src/types.ts";
import runWorkflow from "../../o-agents/workflowInternalTest.ts";

const issueData: IssueData = {
  title: "Internal workflow smoke test",
  body: "Confirm agent can post results to the local callback server.",
  url: "https://example.invalid/issues/0",
  comments: [],
};

async function runInternalWorkflow(tool: AgentTool): Promise<number> {
  return runWorkflow({
    tool,
    issueData,
    baseBranch: "main",
    headBranch: "internal-test",
    cwd: process.cwd(),
  });
}

test(
  "internal workflow e2e: gemini-cli",
  async () => {
    const exitCode = await runInternalWorkflow("gemini-cli");
    expect(exitCode).toBe(0);
  },
  { timeout: 1000 * 60 * 60 },
);
