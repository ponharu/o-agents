import type { IssueData, RepoInfo, WorkKind } from "../types.ts";
import { runCommandWithOutput } from "../utils/run.ts";

type GitHubIssueComment = {
  id: number;
  body?: string;
  html_url?: string;
};

export async function getRepoInfo(): Promise<RepoInfo> {
  const repoResult = await runCommandWithOutput(
    "gh",
    ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
    { throwOnError: true, cwd: process.cwd() },
  );
  return JSON.parse(repoResult.stdout) as RepoInfo;
}

export async function upsertComparisonComment(options: {
  repo: string;
  targetNumber: number;
  body: string;
  marker: string;
}): Promise<{ action: "created" | "updated"; htmlUrl?: string }> {
  const { repo, targetNumber, body, marker } = options;
  const listResult = await runCommandWithOutput(
    "gh",
    ["api", `repos/${repo}/issues/${targetNumber}/comments`, "--paginate"],
    { throwOnError: true, cwd: process.cwd() },
  );
  const comments = parseGhApiJson<GitHubIssueComment[]>(listResult.stdout, "issue comments");
  const existing = comments.find((comment) => (comment.body ?? "").includes(marker));

  if (existing) {
    const updateResult = await runCommandWithOutput(
      "gh",
      [
        "api",
        "--method",
        "PATCH",
        `repos/${repo}/issues/comments/${existing.id}`,
        "-f",
        `body=${body}`,
      ],
      { throwOnError: true, cwd: process.cwd() },
    );
    const updated = parseGhApiJson<GitHubIssueComment>(updateResult.stdout, "updated comment");
    return { action: "updated", htmlUrl: updated.html_url };
  }

  const createResult = await runCommandWithOutput(
    "gh",
    ["api", `repos/${repo}/issues/${targetNumber}/comments`, "-f", `body=${body}`],
    { throwOnError: true, cwd: process.cwd() },
  );
  const created = parseGhApiJson<GitHubIssueComment>(createResult.stdout, "created comment");
  return { action: "created", htmlUrl: created.html_url };
}

async function getIssueData(issueNumber: number): Promise<IssueData> {
  return getIssueOrPullRequestData("issue", issueNumber);
}

async function getPullRequestData(prNumber: number): Promise<IssueData> {
  return getIssueOrPullRequestData("pr", prNumber);
}

export async function fetchIssueOrPullRequestData(
  kind: "issue" | "pr",
  number: number,
): Promise<IssueData> {
  const data = kind === "issue" ? await getIssueData(number) : await getPullRequestData(number);
  return { ...data, kind, number };
}

export async function resolveTargetKind(
  target: string,
): Promise<{ kind: WorkKind; number: number }> {
  const trimmed = target.trim();
  if (!trimmed) {
    throw new Error("Target cannot be empty.");
  }

  const urlMatch = matchTargetUrl(trimmed);
  if (urlMatch) {
    const number = Number(urlMatch.number);
    if (!Number.isFinite(number) || number <= 0) {
      throw new Error(`Invalid GitHub URL target: ${target}`);
    }
    return { kind: urlMatch.kind, number };
  }

  const numberMatch = matchTargetNumber(trimmed);
  if (!numberMatch) {
    throw new Error(`Invalid target "${target}". Provide an issue/PR number or GitHub URL.`);
  }

  const number = Number(numberMatch);
  const issueResult = await runCommandWithOutput(
    "gh",
    ["issue", "view", String(number), "--json", "number"],
    { throwOnError: false, cwd: process.cwd() },
  );
  if (issueResult.exitCode === 0 && parseGhNumber(issueResult.stdout)) {
    return { kind: "issue", number };
  }

  const prResult = await runCommandWithOutput(
    "gh",
    ["pr", "view", String(number), "--json", "number"],
    { throwOnError: false, cwd: process.cwd() },
  );
  if (prResult.exitCode === 0 && parseGhNumber(prResult.stdout)) {
    return { kind: "pr", number };
  }

  throw new Error(`No issue or PR found for #${number}.`);
}

async function getIssueOrPullRequestData(kind: "issue" | "pr", number: number): Promise<IssueData> {
  const fields = ["title", "body", "url", "comments"];
  if (kind === "pr") {
    fields.push("headRefName");
  }
  const result = await runCommandWithOutput(
    "gh",
    [kind, "view", String(number), "--json", fields.join(",")],
    { throwOnError: true, cwd: process.cwd() },
  );
  return JSON.parse(result.stdout) as IssueData;
}

function matchTargetUrl(target: string): { kind: WorkKind; number: string } | undefined {
  const pullMatch = target.match(/\/pull\/(\d+)/);
  if (pullMatch) {
    const number = pullMatch[1];
    if (number) {
      return { kind: "pr", number };
    }
  }
  const issueMatch = target.match(/\/issues\/(\d+)/);
  if (issueMatch) {
    const number = issueMatch[1];
    if (number) {
      return { kind: "issue", number };
    }
  }
  return undefined;
}

function matchTargetNumber(target: string): string | undefined {
  const normalized = target.startsWith("#") ? target.slice(1) : target;
  if (/^\d+$/.test(normalized)) {
    return normalized;
  }
  return undefined;
}

function parseGhNumber(output: string): number | undefined {
  if (!output.trim()) return undefined;
  try {
    const parsed = JSON.parse(output) as { number?: number };
    if (typeof parsed.number === "number" && Number.isFinite(parsed.number)) {
      return parsed.number;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseGhApiJson<T>(output: string, context: string): T {
  if (!output.trim()) {
    throw new Error(`Empty response from gh api for ${context}.`);
  }
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse gh api ${context} response: ${message}`);
  }
}
