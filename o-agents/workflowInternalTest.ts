import type { AgentTool, IssueData } from "o-agents";
import { logger, RESULT_DELIVERY_INSTRUCTION, runNonInteractiveAgent } from "o-agents";
import { z } from "zod";

type WorkflowContext = {
  tool: AgentTool;
  issueData: IssueData;
  baseBranch: string;
  headBranch: string;
  cwd: string;
};

const resultSchema = z.object({ status: z.literal("ok") });

export default async function runWorkflow({ tool, cwd }: WorkflowContext): Promise<number> {
  const prompt = [
    'Post the exact JSON object `{ "status": "ok" }` as the result.',
    "Do not include any other text.",
    RESULT_DELIVERY_INSTRUCTION,
  ].join("\n");
  const result = await runNonInteractiveAgent({ tool, prompt, cwd, schema: resultSchema });
  logger.info(`Internal test workflow result: ${JSON.stringify(result)}`);
  return result.status === "ok" ? 0 : 1;
}
