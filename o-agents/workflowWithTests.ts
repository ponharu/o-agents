import {
  buildImplementationPrompt,
  buildPlanPrompt,
  buildPullRequestBody,
  buildReviewPrompt,
  buildReviewResolutionPrompt,
  buildTestFixPrompt,
  createPullRequest,
  ensureCommitAndPushChanges,
  logger,
  runCommandWithOutput,
  runNonInteractiveAgent,
} from "o-agents";
import type { AgentTool, IssueData } from "o-agents";
import { z } from "zod";
import { reviewCommentSchema, reviewResponseSchema } from "./schemas.ts";

export const paramsSchema = z.object({
  testCommand: z
    .preprocess(
      (value) => {
        if (typeof value === "string") {
          return value.trim().split(/\s+/).filter(Boolean);
        }
        return value;
      },
      z.array(z.string().min(1)).min(1),
    )
    .optional()
    .default(["bun", "test"]),
});

type WorkflowParams = z.infer<typeof paramsSchema>;
type WorkflowContext = {
  tool: AgentTool;
  issueData: IssueData;
  baseBranch: string;
  headBranch: string;
  cwd: string;
};

const MAX_REVIEW_FIX_ATTEMPTS = 3;
const MAX_TEST_FIX_ATTEMPTS = 5;

export default async function runWorkflow(
  { tool, issueData, baseBranch, headBranch, cwd }: WorkflowContext,
  params: WorkflowParams,
): Promise<number> {
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

  let lastExitCode = 0;
  const [command, ...args] = params.testCommand;
  if (!command) {
    throw new Error("testCommand must not be empty.");
  }
  for (let count = 0; count < MAX_TEST_FIX_ATTEMPTS; count++) {
    const { combined, exitCode } = await runCommandWithOutput(command, args, { cwd });
    lastExitCode = exitCode;
    if (exitCode === 0) {
      return 0;
    }
    logger.info("Tests failed, running test-fixing agent...");
    await runNonInteractiveAgent({
      tool,
      prompt: buildTestFixPrompt({ headBranch, testOutput: combined }),
      cwd,
    });
    await ensureCommitAndPushChanges("chore: apply changes from test-fixing agent", { cwd });
  }
  return lastExitCode || 1;
}
