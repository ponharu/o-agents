import type { IssueData } from "../types.ts";
import YAML from "yaml";
import { yamlStringifyOptions } from "../utils/yaml.ts";
import { z } from "zod";

export const RESULT_DELIVERY_INSTRUCTION = "{RESULT_DELIVERY_INSTRUCTION}";

export function buildPlanPrompt({ issueData }: { issueData: IssueData }): string {
  return `
Create an implementation plan for modifying files in the current repository to resolve the request below, and deliver the plan as markdown content using the response instructions that follow.

Request:
~~~~yaml
${YAML.stringify(
  {
    title: issueData.title,
    body: issueData.body,
    comments: issueData.comments,
  },
  yamlStringifyOptions,
).trim()}
~~~~
  
Requirements:
- Create a plan only; do not modify any files.
- Find and thoroughly read all relevant files to understand the current implementation.
- If external libraries or APIs are required:
  - Search for their latest documentation.
  - Include them in the plan with relevant usage details.
  - Include the source URLs in the plan.
- Use \`gh\` and \`git\` commands to explore the repository if needed.
- Design the plan in detail so that developers can implement it without needing the original request.
- Even if the request is ambiguous, create an actionable plan based on reasonable assumptions.

${RESULT_DELIVERY_INSTRUCTION}`.trim();
}

export function buildImplementationPrompt({ plan }: { plan: string }): string {
  return `
Implement the following plan on the current branch and return the change summary as markdown content.

Plan:
~~~~md
${plan.trim()}
~~~~

Requirements:
- Do not run tests.
- Commit your changes with a conventional commit prefix: feat|fix|perf|refactor|test|build|chore|ci|docs|style.
- Push the changes to the origin remote.

${RESULT_DELIVERY_INSTRUCTION}`.trim();
}

export function buildReviewPrompt({ headBranch }: { headBranch: string }): string {
  return `
Review the changes from the current branch compared to the \`${headBranch}\` branch, and deliver the review comments as a JSON array using the response instructions that follow.

${RESULT_DELIVERY_INSTRUCTION}`.trim();
}

export function buildReviewResolutionPrompt({
  reviewComments,
}: {
  reviewComments: unknown[];
}): string {
  return `
Address the review comments below, and deliver a response to each comment as a JSON array using the response instructions that follow.

Review comments:
~~~~yaml
${YAML.stringify(reviewComments, yamlStringifyOptions).trim()}
~~~~

Requirements:
- Carefully consider each review comment and determine if it is reasonable and improves the code quality.
- If a comment is not reasonable or does not provide value, decline it with a clear explanation.
- Only implement changes for comments that you agree with.
- Do not run tests.
- Commit your changes with a conventional commit prefix: feat|fix|perf|refactor|test|build|chore|ci|docs|style.
- Push the current branch to origin.

${RESULT_DELIVERY_INSTRUCTION}`.trim();
}

export function buildTestFixPrompt({
  headBranch,
  testOutput,
}: {
  headBranch: string;
  testOutput: string;
}): string {
  return `
The changes on the current branch compared to the \`${headBranch}\` branch have caused test failures.
Fix the failing tests based on the provided output below.

Test output:
~~~~
${testOutput}
~~~~

Requirements:
- Write or update test code and apply any necessary production code fixes; do not run tests.
- Commit your changes with a conventional commit prefix: feat|fix|perf|refactor|test|build|chore|ci|docs|style.
- Push the current branch to origin.
`.trim();
}

export const comparePullRequestsSchema = z.object({
  bestPrUrl: z.string().min(1),
  reason: z.string().min(1),
});

export function buildComparePullRequestsPrompt({
  issueData,
  pullRequestEntries,
}: {
  issueData: IssueData;
  pullRequestEntries: { url: string; worktreePath: string }[];
}): string {
  return `
Compare the pull requests below and select the best implementation based on the rubric.
If any improvements from other PRs are worth integrating, move to the worktree directory of the best PR, manually apply the improvements, commit, and push the updates.
Finally, deliver a JSON response with the best PR URL (or "N/A" if none are acceptable) and a brief reason using the response instructions that follow.

Rubric (prioritize in order):
1. Correctness: Fully addresses the issue request without introducing bugs.
2. Simplicity: Reduces overall codebase size by eliminating redundancy and unnecessary code.
3. Code quality: Maintainable, readable, and follows project conventions.

Issue context:
~~~~yaml
${YAML.stringify(
  {
    title: issueData.title,
    body: issueData.body,
    comments: issueData.comments,
  },
  yamlStringifyOptions,
).trim()}
~~~~

Pull request entries:
~~~~yaml
${YAML.stringify(pullRequestEntries, yamlStringifyOptions).trim()}
~~~~

${RESULT_DELIVERY_INSTRUCTION}`.trim();
}
