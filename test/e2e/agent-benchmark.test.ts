import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentTool } from "../../src/types.ts";

const REPO_URL = "https://github.com/exKAZUu/agent-benchmark";
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_SIMPLE_PATH = path.join(ROOT_DIR, "o-agents", "workflowSimple.ts");
const TEST_TIMEOUT = 1000 * 60 * 30;

type RunResult = {
  stdout: string;
  stderr: string;
  combined: string;
  exitCode: number;
};

async function runCommand(
  command: string[],
  options: {
    cwd: string;
    throwOnError?: boolean;
    streamOutput?: boolean;
  },
): Promise<RunResult> {
  const throwOnError = options.throwOnError ?? true;
  const streamOutput = options.streamOutput ?? false;
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = proc.stdout
    ? readStream(proc.stdout, streamOutput ? process.stdout : undefined)
    : Promise.resolve("");
  const stderrPromise = proc.stderr
    ? readStream(proc.stderr, streamOutput ? process.stderr : undefined)
    : Promise.resolve("");
  const [stdout, stderr, exitCode] = await Promise.all([stdoutPromise, stderrPromise, proc.exited]);
  const combined = `${stdout}${stderr}`;
  if (throwOnError && exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(" ")}\n${combined}`);
  }
  return { stdout, stderr, combined, exitCode };
}

async function assertCleanWorkingTree(cwd: string): Promise<void> {
  const status = await runCommand(["git", "status", "--porcelain"], { cwd });
  expect(status.stdout.trim()).toBe("");
}

async function removeNonMainRemoteBranches(repoDir: string): Promise<void> {
  console.log("Removing non-main remote branches...");
  const keepBranches = new Set(["HEAD", "main"]);

  const branchNames = await listRemoteBranches(repoDir);
  for (const branch of branchNames) {
    if (keepBranches.has(branch)) {
      continue;
    }
    console.log(`Deleting remote branch ${branch}`);
    await runCommand(["git", "push", "origin", "--delete", branch], {
      cwd: repoDir,
    });
  }
}

async function assertPullRequestCreated(
  repoDir: string,
  branchName: string,
  runStartedAt: Date,
): Promise<void> {
  const prResult = await runCommand(
    ["gh", "pr", "list", "--head", branchName, "--json", "number,createdAt", "--jq", ".[0]"],
    { cwd: repoDir },
  );
  const prData = prResult.stdout.trim();
  if (!prData || prData === "null") {
    throw new Error(`Failed to find PR for branch ${branchName}.`);
  }
  const parsed = JSON.parse(prData) as { number?: number; createdAt?: string };
  const prNumber = String(parsed.number ?? "");
  const createdAt = parsed.createdAt ? new Date(parsed.createdAt) : undefined;
  if (!prNumber || prNumber === "undefined" || !createdAt) {
    throw new Error(`Failed to parse PR data for branch ${branchName}.`);
  }
  expect(createdAt.getTime()).toBeGreaterThanOrEqual(runStartedAt.getTime());

  console.log(`Found PR #${prNumber}. Checking out PR code...`);
  await runCommand(["gh", "pr", "checkout", prNumber, "--force"], {
    cwd: repoDir,
  });
}

async function runAgentBenchmarkCase(config: {
  issueRef: string;
  workflowPath: string;
  mainTool: AgentTool;
  compareTools?: AgentTool[];
  validateOutput: (repoDir: string) => Promise<void>;
  validateRunOutput?: (output: string) => void;
}): Promise<void> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "agent-benchmark-"));
  const repoDir = path.join(workDir, "agent-benchmark");

  let branchNames: string[] = [];
  try {
    console.log(`Cloning ${REPO_URL}...`);
    await runCommand(["git", "clone", REPO_URL, repoDir], { cwd: process.cwd() });

    await removeNonMainRemoteBranches(repoDir);

    const compareTools = config.compareTools ?? [];
    const toolsLabel = [config.mainTool, ...compareTools].join(", ");
    console.log(`Running o-agents with ${toolsLabel} for issue ${config.issueRef}...`);
    const runStartedAt = new Date();
    const command = [
      "bun",
      path.join(ROOT_DIR, "src/index.ts"),
      "--target",
      config.issueRef,
      "--main",
      config.mainTool,
      config.workflowPath,
    ];
    for (const compareTool of compareTools) {
      command.push("--compare", compareTool, config.workflowPath);
    }
    const runResult = await runCommand(command, {
      cwd: repoDir,
      streamOutput: true,
    });
    if (config.validateRunOutput) {
      config.validateRunOutput(runResult.combined);
    }
    await assertCleanWorkingTree(repoDir);

    branchNames = (await listRemoteBranches(repoDir)).filter((branch) => branch !== "main");
    if (branchNames.length === 0) {
      throw new Error("Failed to detect current branch after running o-agents.");
    }
    if (compareTools.length > 0 && branchNames.length < compareTools.length + 1) {
      throw new Error("Expected branches for both main and compare runs.");
    }

    for (const branchName of branchNames) {
      await assertPullRequestCreated(repoDir, branchName, runStartedAt);
    }

    await runCommand(["bun", "install"], { cwd: repoDir });
    await runCommand(["bun", "test"], { cwd: repoDir });

    await config.validateOutput(repoDir);

    console.log("E2E test passed.");
  } finally {
    for (const branchName of branchNames) {
      await runCommand(["git", "push", "origin", "--delete", branchName], {
        cwd: repoDir,
        throwOnError: false,
      });
    }
    await rm(workDir, { recursive: true, force: true });
  }
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  output: NodeJS.WritableStream | undefined,
): Promise<string> {
  const decoder = new TextDecoder();
  let result = "";
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    result += text;
    if (output) {
      output.write(text);
    }
  }
  return result;
}

async function listRemoteBranches(repoDir: string): Promise<string[]> {
  const remoteRefs = await runCommand(
    ["git", "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"],
    { cwd: repoDir },
  );
  return remoteRefs.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((remoteRef) => remoteRef.startsWith("origin/"))
    .map((remoteRef) => remoteRef.slice("origin/".length));
}

test(
  "agent-benchmark issue #1 e2e",
  async () => {
    await runAgentBenchmarkCase({
      issueRef: "#1",
      workflowPath: WORKFLOW_SIMPLE_PATH,
      mainTool: "gemini-cli",
      validateOutput: async (repoDir) => {
        const runResult = await runCommand(["bun", "run", "src/index.ts", "hello"], {
          cwd: repoDir,
          throwOnError: false,
        });
        console.log(runResult.combined);

        expect(runResult.stdout).toContain("Hello, World!");
        expect(runResult.exitCode).toBe(0);
      },
    });
  },
  { timeout: TEST_TIMEOUT },
);

test(
  "agent-benchmark issue #4 e2e",
  async () => {
    await runAgentBenchmarkCase({
      issueRef: "https://github.com/exKAZUu/agent-benchmark/issues/4",
      workflowPath: WORKFLOW_SIMPLE_PATH,
      mainTool: "codex-cli",
      compareTools: ["claude-code"],
      validateRunOutput: (output) => {
        expect(output).toContain("Best PR:");
        expect(output).toContain("Selection reason:");
      },
      validateOutput: async (repoDir) => {
        const runResult = await runCommand(["bun", "run", "src/index.ts", "calc", "10", "%", "3"], {
          cwd: repoDir,
        });
        console.log(runResult.combined);

        expect(runResult.stdout.trim()).toBe("1");
        expect(runResult.exitCode).toBe(0);
      },
    });
  },
  { timeout: TEST_TIMEOUT },
);
