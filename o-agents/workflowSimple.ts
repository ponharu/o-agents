import type { AgentTool, IssueData } from "o-agents";
import {
  buildImplementationPrompt,
  buildPlanPrompt,
  buildPullRequestBody,
  createPullRequest,
  ensureCommitAndPushChanges,
  runNonInteractiveAgent,
} from "o-agents";

type WorkflowContext = {
  tool: AgentTool;
  issueData: IssueData;
  baseBranch: string;
  headBranch: string;
  cwd: string;
};

export default async function runWorkflow({
  tool,
  issueData,
  baseBranch,
  headBranch,
  cwd,
}: WorkflowContext): Promise<number> {
  const plan = await runNonInteractiveAgent({
    tool,
    prompt: buildPlanPrompt({ issueData }),
    cwd,
  });
  const changeSummary = await runNonInteractiveAgent({
    tool,
    prompt: buildImplementationPrompt({ plan }),
    cwd,
  });
  await ensureCommitAndPushChanges("chore: apply changes from implementation agent", { cwd });
  await createPullRequest(
    baseBranch,
    headBranch,
    buildPullRequestBody(issueData, plan, changeSummary),
    { cwd },
  );

  return 0;
}
