import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

export const O_AGENTS_LOGS_DIR = ".o-agents-logs";

import simpleGit, { type SimpleGit } from "simple-git";

import { logger } from "../utils/logger.ts";
import { runCommandWithOutput } from "../utils/run.ts";
import { getErrorMessage } from "../utils/error.ts";

const pullRequestUrlByBranch = new Map<string, string>();

export async function ensureCleanGit(cwd: string): Promise<void> {
  const git = getGit(cwd);
  if (await hasChanges(git)) {
    throw new Error("Working tree is not clean. Commit or stash changes first.");
  }
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const git = getGit(cwd);
  const branch = await git.branchLocal();
  return branch.current;
}

export async function createWorktree(
  branchName: string,
  baseBranch: string,
  worktreePath: string,
): Promise<{ branchName: string; baseRef: string; worktreePath: string }> {
  const git = getGit(process.cwd());
  let finalBranch = branchName;
  const branchRef = `refs/heads/${finalBranch}`;
  if (await gitRefExists(git, branchRef)) {
    finalBranch = `${branchName}-${Date.now()}`;
  }

  let baseRef = baseBranch;
  if (await gitRemoteExists(git, "origin")) {
    await git.fetch("origin", baseBranch);
    const remoteRef = `refs/remotes/origin/${baseBranch}`;
    if (await gitRefExists(git, remoteRef)) {
      baseRef = `origin/${baseBranch}`;
    }
  }

  // Serialize worktree creation to avoid .git/config.lock conflicts across parallel runs.
  await withWorktreeLock(() =>
    git.raw(["worktree", "add", "-b", finalBranch, worktreePath, baseRef]),
  );
  return { branchName: finalBranch, baseRef, worktreePath };
}

export async function removeWorktree(worktreePath: string): Promise<void> {
  const git = getGit(process.cwd());
  try {
    await git.raw(["worktree", "remove", worktreePath]);
    return;
  } catch {
    try {
      await git.raw(["worktree", "remove", "--force", worktreePath]);
      return;
    } catch {
      try {
        await git.raw(["worktree", "prune"]);
        await git.raw(["worktree", "remove", "--force", worktreePath]);
        return;
      } catch (pruneError) {
        const message = getErrorMessage(pruneError);
        throw new Error(`Failed to remove worktree at ${worktreePath}: ${message}`);
      }
    }
  }
}

export async function ensureCommitAndPushChanges(
  message: string,
  options: { cwd: string },
): Promise<void> {
  const git = getGit(options.cwd);
  const committed = await commitAndPushIfChanges(git, message);
  if (!committed) {
    logger.info("No changes to commit.");
  }
}

export async function createPullRequest(
  baseBranch: string,
  headBranch: string,
  body: string,
  options: { cwd: string },
): Promise<void> {
  const tempDir = join(process.cwd(), O_AGENTS_LOGS_DIR, "app", "temp");
  mkdirSync(tempDir, { recursive: true });
  const bodyPath = join(tempDir, `pr-body-${Date.now()}.md`);
  writeFileSync(bodyPath, body, "utf8");
  const title = await getLastCommitTitle(options.cwd);

  const { stdout, stderr } = await runCommandWithOutput(
    "gh",
    [
      "pr",
      "create",
      "--base",
      baseBranch,
      "--head",
      headBranch,
      "--title",
      title,
      "--body-file",
      bodyPath,
    ],
    { stream: true, throwOnError: true, cwd: options.cwd },
  );

  void rm(bodyPath, { force: true });
  const pullRequestUrl = extractPullRequestUrl(stdout, stderr);
  if (pullRequestUrl) {
    pullRequestUrlByBranch.set(headBranch, pullRequestUrl);
  }
}

async function getLastCommitTitle(cwd: string): Promise<string> {
  const git = getGit(cwd);
  const title = (await git.raw(["log", "-1", "--pretty=%s"])).trim();
  if (!title) {
    throw new Error("Failed to determine last commit title for pull request.");
  }
  return title;
}

export function extractPullRequestUrl(stdout: string, stderr: string): string | undefined {
  const output = stdout.trim() ? stdout : stderr;
  if (!output) {
    return undefined;
  }
  const urls = output.match(/https?:\/\/[^\s]+/g) ?? [];
  if (urls.length === 0) {
    return undefined;
  }
  const cleaned = urls.map((url) => url.replace(/[),.]+$/, ""));
  const prPattern = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
  const prUrls = cleaned.filter((url) => prPattern.test(url));
  if (prUrls.length > 0) {
    return prUrls[prUrls.length - 1];
  }
  return cleaned[cleaned.length - 1];
}

export function getPullRequestUrlForBranch(branchName: string): string | undefined {
  return pullRequestUrlByBranch.get(branchName);
}

function getGit(cwd: string): SimpleGit {
  return simpleGit({ baseDir: cwd });
}

async function gitRemoteExists(git: SimpleGit, name: string): Promise<boolean> {
  const remotes = await git.getRemotes(true);
  return remotes.some((remote) => remote.name === name);
}

async function gitRefExists(git: SimpleGit, ref: string): Promise<boolean> {
  try {
    await git.raw(["show-ref", "--verify", ref]);
    return true;
  } catch {
    return false;
  }
}

async function hasChanges(git: SimpleGit): Promise<boolean> {
  const status = await git.status();
  return status.files.length > 0;
}

async function commitAndPushIfChanges(
  git: SimpleGit,
  message: string,
  footer?: string,
): Promise<boolean> {
  if (!(await hasChanges(git))) {
    return false;
  }

  await git.add(["-A"]);
  if (footer) {
    await git.raw(["commit", "-m", message, "-m", footer]);
  } else {
    await git.commit(message);
  }

  await pushToOriginIfExists(git);
  return true;
}

async function pushToOriginIfExists(git: SimpleGit): Promise<void> {
  if (await gitRemoteExists(git, "origin")) {
    await git.push("origin", "HEAD");
  } else {
    logger.info("Skipped push: git remote 'origin' not found.");
  }
}

let worktreeQueue: Promise<void> = Promise.resolve();

async function withWorktreeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = worktreeQueue.then(fn, fn);
  worktreeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export function ensureGitignoreHasOAgents(cwd: string): void {
  const infoDir = join(cwd, ".git", "info");
  if (!existsSync(infoDir)) {
    return;
  }

  const excludePath = join(infoDir, "exclude");
  const entries = [`${O_AGENTS_LOGS_DIR}/`];

  if (!existsSync(excludePath)) {
    writeFileSync(excludePath, `${entries.join("\n")}\n`, "utf8");
    return;
  }

  const content = readFileSync(excludePath, "utf8");
  const lines = content.split("\n").map((line) => line.trim());
  const entriesToAdd = entries.filter(
    (entry) => !lines.some((line) => line === entry || line === entry.slice(0, -1)),
  );

  if (entriesToAdd.length > 0) {
    const suffix = content.endsWith("\n") ? "" : "\n";
    writeFileSync(excludePath, `${content}${suffix}${entriesToAdd.join("\n")}\n`, "utf8");
  }
}
