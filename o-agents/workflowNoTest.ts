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

type WorkflowContext = {
  tool: AgentTool;
  issueData: IssueData;
  baseBranch: string;
  headBranch: string;
  cwd: string;
};

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
    const reviewComments = await runNonInteractiveAgent({
      tool,
      prompt: buildReviewPrompt({ headBranch }),
      schema: reviewCommentSchema,
      cwd,
    });
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
