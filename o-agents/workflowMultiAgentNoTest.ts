import type { AgentTool, IssueData } from "o-agents";
import {
  buildImplementationPrompt,
  buildPlanPrompt,
  buildPullRequestBody,
  buildReviewPrompt,
  buildReviewResolutionPrompt,
  createPullRequest,
  ensureCommitAndPushChanges,
  runNonInteractiveAgent,
} from "o-agents";
import { reviewCommentSchema, reviewResponseSchema } from "./schemas.ts";
import { runNonInteractiveAgents } from "../src/agent/workflowRunner.ts";

type WorkflowContext = {
  tool: AgentTool;
  issueData: IssueData;
  baseBranch: string;
  headBranch: string;
  cwd: string;
};

const REVIEW_AGENTS: AgentTool[] = ["codex-cli", "claude-code", "gemini-cli"];
const MAX_REVIEW_FIX_ATTEMPTS = 3;

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
  for (let count = 0; count < MAX_REVIEW_FIX_ATTEMPTS; count++) {
    const reviewCommentsList = await runNonInteractiveAgents({
      tools: REVIEW_AGENTS,
      prompt: buildReviewPrompt({ headBranch }),
      schema: reviewCommentSchema,
      cwd,
    });
    const reviewComments = reviewCommentsList.flat();
    if (reviewComments.length === 0) break;

    await runNonInteractiveAgent({
      tool,
      prompt: buildReviewResolutionPrompt({
        reviewComments,
      }),
      schema: reviewResponseSchema,
      cwd,
    });
    await ensureCommitAndPushChanges("chore: apply changes from review resolution agent", { cwd });
  }

  return 0;
}
