import type { IssueData } from "../types.ts";

export function buildPullRequestBody(issue: IssueData, plan?: string, summary?: string): string {
  const number = issue.number;
  const changeSummary = summary?.trim() || "No summary provided.";
  const planSection = plan?.trim() || "No plan provided.";
  const sections = ["## Summary", changeSummary, "", "## Plan", planSection];

  if (number) {
    sections.unshift(`Closes #${number}`, "");
  }

  return sections.join("\n");
}
