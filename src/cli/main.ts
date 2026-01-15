import { existsSync, mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ZodTypeAny } from "zod";
import { runNonInteractiveAgent, setAgentConcurrency } from "../agent/workflowRunner.ts";
import { parseArgs } from "./parseArgs.ts";
import { fetchIssueOrPullRequestData, getRepoInfo, resolveTargetKind } from "../github/gh.ts";
import {
  createWorktree,
  ensureCleanGit,
  ensureGitignoreHasOAgents,
  getCurrentBranch,
  getPullRequestUrlForBranch,
  O_AGENTS_LOGS_DIR,
  removeWorktree,
} from "../git/git.ts";
import { logger } from "../utils/logger.ts";
import { buildComparePullRequestsPrompt, comparePullRequestsSchema } from "../agent/prompt.ts";
import type { AgentTool, IssueData, ParsedArgs, WorkKind, WorkflowSpec } from "../types.ts";
import { getErrorMessage } from "../utils/error.ts";
import { formatRunTimestamp } from "../utils/time.ts";
import { runCommandWithOutput, setCommandConcurrency } from "../utils/run.ts";
import { hasNodeRuntime } from "../utils/runtime.ts";

type WorkflowFunction = (
  context: {
    tool: AgentTool;
    issueData: IssueData;
    baseBranch: string;
    headBranch: string;
    cwd: string;
  },
  params: unknown,
) => Promise<number>;

type WorkflowModule = {
  run: WorkflowFunction;
  paramsSchema?: ZodTypeAny;
  workflowPath: string;
};

type WorkflowRunPlan = {
  kind: "main" | "compare";
  spec: WorkflowSpec;
};

type WorkflowRunResult = {
  kind: "main" | "compare";
  tool: AgentTool;
  workflowPath: string;
  logPath: string;
  branchName?: string;
  pullRequestUrl?: string;
  worktreePath?: string;
  exitCode: number;
  error?: string;
};

export async function main(): Promise<void> {
  if (!hasNodeRuntime()) {
    throw new Error("Node.js is required to run agents via npx.");
  }
  const args = parseArgs(process.argv);
  const cwd = process.cwd();
  const logsBaseDir = join(cwd, O_AGENTS_LOGS_DIR, "app");
  const runTimestamp = formatRunTimestamp();
  const logDir = join(logsBaseDir, runTimestamp);
  mkdirSync(logDir, { recursive: true });
  ensureGitignoreHasOAgents(cwd);
  let overallExitCode = 0;
  let logPath = "";

  let results: WorkflowRunResult[] = [];
  const activeWorktrees = new Set<string>();
  installSignalHandlers(() => cleanupWorktrees(results, Array.from(activeWorktrees)));
  try {
    setAgentConcurrency(args.concurrency);
    setCommandConcurrency(args.commandConcurrency);
    const { kind, number } = await resolveTargetKind(args.target);
    const runLabel = `${kind}-${number}`;
    logPath = join(logDir, `run-${runLabel}.log`);
    logger.logPath = logPath;
    await ensureCleanGit(cwd);

    const rawIssueData = await fetchIssueOrPullRequestData(kind, number);
    const repoInfo = await getRepoInfo();
    const issueData = { ...rawIssueData, repo: repoInfo };

    const baseBranch =
      kind === "issue" ? await getCurrentBranch(cwd) : (rawIssueData.headRefName ?? "");
    if (!baseBranch) {
      throw new Error(`Failed to determine base branch for ${kind} ${number}.`);
    }

    const { mainSpec, compareSpecs } = resolveWorkflowSpecs(args);
    const workflowRuns = buildWorkflowRuns(mainSpec, compareSpecs);
    const branchTimestamp = formatRunTimestamp();
    const runPromises = workflowRuns.map((runPlan, index) => {
      const runIndex = index + 1;
      const workflowLogPath = createWorkflowLogPath(logDir, runLabel, runPlan.kind, runIndex);
      const runPrefix = `[${runPlan.kind}-${runIndex}]`;
      return logger.runWithContext(
        { extraLogPaths: [workflowLogPath], mainPrefix: runPrefix },
        async () =>
          await executeWorkflowRun({
            runPlan,
            runIndex,
            kind,
            number,
            baseBranch,
            issueData,
            branchTimestamp,
            workflowLogPath,
            initCommand: args.initCommand,
            onWorktreeCreated: (worktreePath) => {
              activeWorktrees.add(worktreePath);
            },
          }),
      );
    });

    results = await Promise.all(runPromises);
    for (const result of results) {
      if (result.exitCode !== 0 && result.kind === "main") {
        overallExitCode = 1;
      }
    }

    if (results.length > 0) {
      await comparePullRequestsIfNeeded({
        issueData,
        results,
        mainTool: mainSpec.tool,
      });
      printRunSummaryList(results);
    } else {
      logger.error("No workflow runs completed; nothing to compare or summarize.");
      overallExitCode = 1;
    }
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error(`Error: ${message}`);
    if (logPath) {
      logger.error(`Log file: ${logPath}`);
    }
    overallExitCode = 1;
  } finally {
    await cleanupWorktrees(results, Array.from(activeWorktrees));
  }

  await writeGithubActionOutputs(overallExitCode);
  emitGithubActionFailure(overallExitCode);

  process.exit(overallExitCode);
}

function createWorkflowLogPath(
  logDir: string,
  runLabel: string,
  runKind: WorkflowRunPlan["kind"],
  runIndex: number,
): string {
  return join(logDir, `workflow-${runLabel}-${runKind}-${runIndex}.log`);
}

async function cleanupWorktrees(
  results: WorkflowRunResult[],
  extraWorktreePaths: string[] = [],
): Promise<void> {
  const paths = new Set([
    ...results.flatMap((result) => (result.worktreePath ? [result.worktreePath] : [])),
    ...extraWorktreePaths,
  ]);
  for (const path of paths) {
    try {
      await removeWorktree(path);
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error(`Failed to clean up worktree: ${message}`);
    }
  }
}

function installSignalHandlers(onCleanup: () => Promise<void>): void {
  let cleanupStarted = false;
  const runCleanup = async (signal: NodeJS.Signals): Promise<void> => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    logger.error(`Received ${signal}. Cleaning up worktrees...`);
    try {
      await onCleanup();
    } catch (error) {
      const message = getErrorMessage(error);
      logger.error(`Failed during cleanup: ${message}`);
    }
    process.exit(1);
  };

  process.once("SIGINT", () => {
    void runCleanup("SIGINT");
  });
  process.once("SIGTERM", () => {
    void runCleanup("SIGTERM");
  });
}

async function writeGithubActionOutputs(exitCode: number): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  try {
    await appendFile(outputPath, `exit-code=${exitCode}\n`);
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error(`Failed to write GitHub Action outputs: ${message}`);
  }
}

function emitGithubActionFailure(exitCode: number): void {
  if (!process.env.GITHUB_ACTIONS || exitCode === 0) {
    return;
  }

  logger.error(`::error::o-agents failed with exit code ${exitCode}`);
}

async function executeWorkflowRun(options: {
  runPlan: WorkflowRunPlan;
  runIndex: number;
  kind: WorkKind;
  number: number;
  baseBranch: string;
  issueData: IssueData;
  branchTimestamp: string;
  workflowLogPath: string;
  initCommand: string;
  onWorktreeCreated?: (worktreePath: string) => void;
}): Promise<WorkflowRunResult> {
  const {
    runPlan,
    runIndex,
    kind,
    number,
    baseBranch,
    issueData,
    branchTimestamp,
    workflowLogPath,
    initCommand,
    onWorktreeCreated,
  } = options;
  const cwd = process.cwd();
  const runLabel = `${runPlan.kind}-${runIndex}`;
  let worktreePath: string | undefined;
  let createdBranch: string | undefined;
  let exitCode = 0;
  let errorMessage: string | undefined;
  let workflowPath = "";

  try {
    const plannedWorktreePath = join(
      dirname(cwd),
      `${basename(cwd)}-o-agents-${formatRunTimestamp()}-${runIndex}`,
    );
    const { branchName, worktreePath: createdWorktreePath } = await createWorktree(
      `o-agents/${kind}-${number}-${branchTimestamp}-${runIndex}`,
      baseBranch,
      plannedWorktreePath,
    );
    worktreePath = createdWorktreePath;
    onWorktreeCreated?.(createdWorktreePath);
    createdBranch = branchName;
    await runInitializationCommand(initCommand, createdWorktreePath);

    const workflow = await loadWorkflow(runPlan.spec.workflow);
    workflowPath = workflow.workflowPath;
    const rawParams = await resolveWorkflowParams(runPlan.spec.params);
    const params = validateWorkflowParams(rawParams, workflow.paramsSchema);

    exitCode = await workflow.run(
      {
        tool: runPlan.spec.tool,
        issueData,
        baseBranch,
        headBranch: branchName,
        cwd: worktreePath,
      },
      params,
    );
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error(`Workflow run failed (${runLabel}): ${message}`);
    exitCode = exitCode || 1;
    errorMessage = message;
  }
  const pullRequestUrl = createdBranch ? getPullRequestUrlForBranch(createdBranch) : undefined;
  return {
    kind: runPlan.kind,
    tool: runPlan.spec.tool,
    workflowPath: workflowPath || "N/A",
    logPath: workflowLogPath,
    branchName: createdBranch,
    pullRequestUrl,
    worktreePath,
    exitCode,
    error: errorMessage,
  };
}

async function runInitializationCommand(initCommand: string, cwd: string): Promise<void> {
  const trimmed = initCommand.trim();
  if (!trimmed) return;
  const { command, args } = splitCommandLine(trimmed);
  const run = () =>
    runCommandWithOutput(command, args, {
      cwd,
      stream: true,
      throwOnError: true,
    });
  if (shouldSerializeInitCommand(command, args)) {
    await runInitCommandSerially(run);
    return;
  }
  await run();
}

function splitCommandLine(value: string): { command: string; args: string[] } {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error(`Init command has an unterminated ${quote} quote.`);
  }
  if (current) {
    args.push(current);
  }
  const [command, ...rest] = args;
  if (!command) {
    throw new Error("Init command cannot be empty.");
  }
  return { command, args: rest };
}

let initCommandLock: Promise<void> = Promise.resolve();

async function runInitCommandSerially<T>(task: () => Promise<T>): Promise<T> {
  const prior = initCommandLock;
  let release!: () => void;
  initCommandLock = new Promise((resolve) => {
    release = resolve;
  });
  await prior;
  try {
    return await task();
  } finally {
    release();
  }
}

function shouldSerializeInitCommand(command: string, args: string[]): boolean {
  if (command === "bunx") return true;
  if (command === "bun" && args[0] === "x") return true;
  return false;
}

async function comparePullRequestsIfNeeded(options: {
  issueData: IssueData;
  results: WorkflowRunResult[];
  mainTool: AgentTool;
}): Promise<void> {
  const { issueData, results, mainTool } = options;
  const pullRequestEntries = results.flatMap((result) =>
    result.pullRequestUrl && result.worktreePath
      ? [{ url: result.pullRequestUrl, worktreePath: result.worktreePath }]
      : [],
  );
  if (pullRequestEntries.length < 2) {
    logger.info("Comparison skipped: fewer than two PR references were created.");
    return;
  }

  try {
    const comparison = await runNonInteractiveAgent({
      tool: mainTool,
      prompt: buildComparePullRequestsPrompt({
        issueData,
        pullRequestEntries,
      }),
      cwd: process.cwd(),
      schema: comparePullRequestsSchema,
    });
    logger.info(`Best PR: ${comparison.bestPrUrl}`);
    logger.info(`Selection reason: ${comparison.reason}`);
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error(`Failed to compare pull requests: ${message}`);
  }
}

function resolveWorkflowSpecs(args: ParsedArgs): {
  mainSpec: WorkflowSpec;
  compareSpecs: WorkflowSpec[];
} {
  return {
    mainSpec: args.main,
    compareSpecs: args.compare ?? [],
  };
}

function buildWorkflowRuns(
  mainSpec: WorkflowSpec,
  compareSpecs: WorkflowSpec[],
): WorkflowRunPlan[] {
  const compareRuns = compareSpecs.map(
    (spec): WorkflowRunPlan => ({
      kind: "compare",
      spec,
    }),
  );
  return [{ kind: "main", spec: mainSpec }, ...compareRuns];
}

async function loadWorkflow(workflowPath?: string): Promise<WorkflowModule> {
  const defaultWorkflow = "o-agents/workflowNoTest.ts";
  const requestedPath = workflowPath ?? defaultWorkflow;
  let resolvedPath = resolve(requestedPath);
  if (!existsSync(resolvedPath) && requestedPath === defaultWorkflow) {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const packagedWorkflow = resolve(packageRoot, defaultWorkflow);
    if (existsSync(packagedWorkflow)) {
      resolvedPath = packagedWorkflow;
    }
  }
  if (!existsSync(resolvedPath)) {
    throw new Error(`Workflow file not found at ${resolvedPath}`);
  }
  const workflowUrl = pathToFileURL(resolvedPath).href;
  const module = await import(workflowUrl);
  if (typeof module.default !== "function") {
    throw new Error(`Workflow file must export a default function: ${workflowUrl}`);
  }
  if (module.paramsSchema && typeof module.paramsSchema.parse !== "function") {
    throw new Error(`Workflow paramsSchema must be a Zod schema: ${workflowUrl}`);
  }
  return {
    run: module.default as WorkflowFunction,
    paramsSchema: module.paramsSchema as ZodTypeAny | undefined,
    workflowPath: resolvedPath,
  };
}

async function resolveWorkflowParams(paramArg: string | undefined): Promise<unknown> {
  if (!paramArg) return undefined;
  const trimmed = paramArg.trim();
  if (!trimmed) return undefined;

  const resolvedPath = resolve(trimmed);
  if (existsSync(resolvedPath)) {
    let contents = "";
    try {
      contents = await readFile(resolvedPath, "utf8");
    } catch (error) {
      const message = getErrorMessage(error);
      throw new Error(`Failed to read params file at ${resolvedPath}: ${message}`);
    }
    try {
      return JSON.parse(contents);
    } catch (error) {
      const message = getErrorMessage(error);
      throw new Error(`Failed to parse JSON file at ${resolvedPath}: ${message}`);
    }
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const message = getErrorMessage(error);
    throw new Error(
      `Failed to parse workflow params as JSON. Provide a valid JSON string or path to a JSON file. ${message}`,
    );
  }
}

function validateWorkflowParams(rawParams: unknown, paramsSchema?: ZodTypeAny): unknown {
  if (!paramsSchema) return rawParams;
  return paramsSchema.parse(rawParams ?? {});
}

function printRunSummaryList(results: WorkflowRunResult[]): void {
  logger.info("Run summary:");
  results.forEach((result, index) => {
    logger.info(`  ${index + 1}. agent=${result.tool}`);
    logger.info(`     workflow=${result.workflowPath || "N/A"}`);
    logger.info(`     log=${result.logPath}`);
    logger.info(`     branch=${result.branchName ?? "N/A"}`);
    logger.info(`     pr=${result.pullRequestUrl ?? "N/A"}`);
    logger.info(`     exit=${result.exitCode}`);
    if (result.error) {
      logger.info(`     error=${result.error}`);
    }
  });
}
