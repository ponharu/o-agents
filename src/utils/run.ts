import { spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { PromisePool } from "minimal-promise-pool";

import type { RunOptions, TerminationPlan } from "../types.ts";
import { logger } from "./logger.ts";
import type { Logger } from "./logger.ts";
import type { AgentResult } from "../agent/resultServer.ts";

let nextCommandId = 0;
let commandPromisePool: PromisePool | undefined;

export async function runCommandWithOutput(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<{ stdout: string; stderr: string; combined: string; exitCode: number }> {
  if (commandPromisePool) {
    return commandPromisePool.runAndWaitForReturnValue(async () =>
      runCommandWithOutputImmediate(command, args, options),
    );
  }
  return runCommandWithOutputImmediate(command, args, options);
}

export function setCommandConcurrency(value?: number): void {
  if (value === undefined) {
    commandPromisePool = undefined;
    return;
  }
  commandPromisePool = new PromisePool(value);
}

async function runCommandWithOutputImmediate(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<{ stdout: string; stderr: string; combined: string; exitCode: number }> {
  const { exit, output } = spawnProcessWithLogging(logger, command, args, options);
  const { code } = await exit;
  if (code !== 0 && options.throwOnError) {
    throw new Error(formatCommandFailureMessage(command, args, code, output.stderr));
  }
  return { ...output, exitCode: code ?? 0 };
}

export async function runAgentUntilResult(
  command: string,
  args: string[],
  waitForResult: Promise<AgentResult<unknown>>,
  options: RunOptions,
): Promise<AgentResult<unknown>> {
  return runAgentLifecycle(command, args, options, async (exit) => {
    const result = await Promise.race([
      waitForResult,
      exit.then(({ code }) => {
        const exitLabel = code ?? "unknown";
        throw new Error(`Agent exited before posting a result (exit ${exitLabel}).`);
      }),
    ]);
    logger.info(`Received agent result: ${JSON.stringify(result)}`);
    return result;
  });
}

export async function runAgentUntilFileExists(
  command: string,
  args: string[],
  logFilePath: string,
  options: RunOptions,
  pollIntervalMs = 1000,
): Promise<void> {
  await runAgentLifecycle(command, args, options, async (exit) => {
    const fileFound = await waitForFileExists(logFilePath, exit, pollIntervalMs);
    if (!fileFound) {
      throw new Error(`Agent exited before writing response file "${logFilePath}".`);
    }
    logger.info(`Found agent response file at ${logFilePath}.`);
  });
}

async function runAgentLifecycle<T>(
  command: string,
  args: string[],
  options: RunOptions,
  task: (exit: Promise<{ code: number | null }>) => Promise<T>,
): Promise<T> {
  const { child, exit, processGroupId } = spawnAgentProcessWithLogging(
    logger,
    command,
    args,
    options,
  );
  const gracePeriodMs = options.agentGracePeriodMs ?? 30_000;

  let result: T | undefined;
  let failure: unknown;

  try {
    result = await task(exit);
  } catch (error) {
    failure = error;
  }

  await finalizeAgentProcess(
    logger,
    child,
    exit,
    gracePeriodMs,
    processGroupId,
    options.mockTerminateProcessTree,
    options.onTerminateProcessTree,
  );

  if (failure) {
    throw failure;
  }
  return result!;
}

function spawnAgentProcessWithLogging(
  logger: Logger,
  command: string,
  args: string[],
  options: RunOptions,
): {
  child: ReturnType<typeof spawn>;
  output: { stdout: string; stderr: string; combined: string };
  exit: Promise<{ code: number | null }>;
  processGroupId?: number;
} {
  return spawnProcessWithLogging(logger, command, args, options, { detached: true });
}

function spawnProcessWithLogging(
  logger: Logger,
  command: string,
  args: string[],
  options: RunOptions,
  spawnOptions?: { detached?: boolean },
): {
  child: ReturnType<typeof spawn>;
  output: { stdout: string; stderr: string; combined: string };
  exit: Promise<{ code: number | null }>;
  processGroupId?: number;
} {
  const streamToConsole = options.stream ?? false;
  const commandId = nextCommandLabel();
  const commandLabel = `$ ${[command, ...args].join(" ")}`;

  return logger.runWithContext({ prefix: commandId }, () => {
    logger.info(commandLabel);

    const detached = spawnOptions?.detached ?? false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached,
    });

    const output = { stdout: "", stderr: "", combined: "" };
    const stdoutBuffer = createLineBuffer((line) => {
      logger.writeChunk(line, streamToConsole, false);
    });
    const stderrBuffer = createLineBuffer((line) => {
      logger.writeChunk(line, streamToConsole, true);
    });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output.stdout += text;
      output.combined += text;
      stdoutBuffer.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output.stderr += text;
      output.combined += text;
      stderrBuffer.write(text);
    });

    const exit = new Promise<{ code: number | null }>((resolve) => {
      let resolved = false;
      const resolveOnce = (code: number | null) => {
        if (resolved) return;
        resolved = true;
        resolve({ code });
      };

      child.on("close", (code) => {
        stdoutBuffer.flush();
        stderrBuffer.flush();
        resolveOnce(code);
      });

      child.on("error", (error) => {
        stdoutBuffer.flush();
        stderrBuffer.flush();
        const message = `Failed to start process: ${error.message}\n`;
        output.stderr += message;
        output.combined += message;
        logger.writeChunk(message, streamToConsole, true);
        resolveOnce(1);
      });
    });

    const processGroupId = detached ? (child.pid ?? undefined) : undefined;
    return { child, output, exit, processGroupId };
  });
}

async function waitForFileExists(
  logFilePath: string,
  exit: Promise<{ code: number | null }>,
  pollIntervalMs: number,
): Promise<boolean> {
  while (true) {
    if (await fileExists(logFilePath)) {
      return true;
    }

    const exited = await Promise.race([
      exit.then(() => true),
      setTimeout(pollIntervalMs).then(() => false),
    ]);
    if (exited) {
      return false;
    }
  }
}

async function fileExists(logFilePath: string): Promise<boolean> {
  try {
    await access(logFilePath);
    return true;
  } catch {
    return false;
  }
}

function formatCommandFailureMessage(
  command: string,
  args: string[],
  code: number | null,
  stderr: string,
): string {
  const exitLabel = code ?? "unknown";
  const commandLabel = [command, ...args].join(" ");
  const trimmed = stderr.trim();
  if (!trimmed) {
    return `Command failed with exit code ${exitLabel}: ${commandLabel}`;
  }

  const maxChars = 500;
  const tail = trimmed.length > maxChars ? trimmed.slice(-maxChars) : trimmed;
  const suffix = trimmed.length > maxChars ? "\n... (stderr truncated)" : "";
  return `Command failed with exit code ${exitLabel}: ${commandLabel}\n${tail}${suffix}`;
}

async function finalizeAgentProcess(
  logger: Logger,
  child: ReturnType<typeof spawn>,
  exit: Promise<{ code: number | null }>,
  gracePeriodMs: number,
  processGroupId?: number,
  mockTerminateProcessTree?: boolean,
  onTerminateProcessTree?: (plan: TerminationPlan) => void,
): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    await exit;
    return;
  }

  const shouldMock = Boolean(mockTerminateProcessTree && process.env.NODE_ENV === "test");
  const exitedDuringGrace = await Promise.race([
    exit.then(() => true),
    setTimeout(gracePeriodMs).then(() => false),
  ]);

  if (!exitedDuringGrace) {
    if (shouldMock) {
      recordMockTermination(logger, child, processGroupId, onTerminateProcessTree);
      return;
    }
    await terminateProcessTree(logger, child, exit, processGroupId, onTerminateProcessTree);
  }

  if (shouldMock) {
    return;
  }

  await exit;
}

async function terminateProcessTree(
  logger: Logger,
  child: ReturnType<typeof spawn>,
  exit: Promise<{ code: number | null }>,
  processGroupId?: number,
  onTerminateProcessTree?: (plan: TerminationPlan) => void,
): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  const signalProcess = (signal: NodeJS.Signals) => {
    const plan = buildTerminationPlan("real", signal, child.pid, processGroupId);
    recordTerminationPlan(logger, onTerminateProcessTree, plan);
    executeTerminationStrategy(plan, child, logger);
  };

  signalProcess("SIGTERM");

  const exited = await Promise.race([exit.then(() => true), setTimeout(5000).then(() => false)]);
  if (exited) return;

  logger.info("Agent did not exit after SIGTERM. Sending SIGKILL...");
  signalProcess("SIGKILL");
}

function executeTerminationStrategy(
  plan: TerminationPlan,
  child: ReturnType<typeof spawn>,
  logger: Logger,
): void {
  switch (plan.strategy) {
    case "windows":
      if (plan.pid) {
        logger.info(`Terminating Windows process tree for pid ${plan.pid} with ${plan.signal}.`);
        terminateWindowsProcessTree(plan.pid);
      }
      break;
    case "darwin-tree":
      if (plan.pid && plan.descendants) {
        logger.info(
          `Terminating macOS process tree for pid ${plan.pid} with ${plan.signal}; descendants=${JSON.stringify(plan.descendants)}`,
        );
        killProcessList(plan.descendants, plan.signal, logger);
        child.kill(plan.signal);
      }
      break;
    case "process-group":
      if (plan.processGroupId) {
        logger.info(`Terminating process group -${plan.processGroupId} with ${plan.signal}.`);
        try {
          process.kill(-plan.processGroupId, plan.signal);
        } catch {
          child.kill(plan.signal);
        }
      } else {
        child.kill(plan.signal);
      }
      break;
    case "child-only":
    case "no-pid":
    default:
      if (plan.strategy === "no-pid") {
        logger.info(`Agent has no pid; sending ${plan.signal} to child process.`);
      } else {
        logger.info(`Terminating child pid ${plan.pid} with ${plan.signal}.`);
      }
      child.kill(plan.signal);
      break;
  }
}

function collectProcessTreeMacOS(rootPid: number): number[] {
  const rootPgid = getProcessGroupIdMacOS(rootPid);
  const toVisit = [rootPid];
  const visited = new Set<number>();
  const descendants: number[] = [];

  while (toVisit.length > 0) {
    const pid = toVisit.pop();
    if (!pid || visited.has(pid)) {
      continue;
    }
    visited.add(pid);

    if (pid !== rootPid) {
      descendants.push(pid);
    }

    for (const childPid of listChildPidsMacOS(pid, rootPgid)) {
      if (!visited.has(childPid)) {
        toVisit.push(childPid);
      }
    }
  }

  return descendants;
}

const PGRP_TIMEOUT_MS = 1000;
const PGRP_MAX_BUFFER = 256 * 1024;

function listChildPidsMacOS(parentPid: number, rootPgid?: number): number[] {
  const result = spawnSync("pgrep", ["-P", `${parentPid}`], {
    encoding: "utf8",
    timeout: PGRP_TIMEOUT_MS,
    maxBuffer: PGRP_MAX_BUFFER,
  });

  if (result.error) {
    return [];
  }

  if (result.status === 1) {
    return [];
  }

  const stdout = result.stdout?.trim() ?? "";
  if (!stdout) {
    return [];
  }

  const pids = stdout
    .split("\n")
    .map((line) => Number(line))
    .filter((pid) => Number.isFinite(pid) && pid > 0);

  if (rootPgid === undefined) {
    return pids;
  }

  return pids.filter((pid) => getProcessGroupIdMacOS(pid) === rootPgid);
}

function killProcessList(pids: number[], signal: NodeJS.Signals, logger: Logger): void {
  for (const pid of pids) {
    if (pid === process.pid || pid === process.ppid) {
      logger.info(`Skipping ${signal} for pid ${pid} to avoid terminating this process.`);
      continue;
    }
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited or cannot be signaled.
    }
  }
}

function getProcessGroupIdMacOS(pid: number): number | undefined {
  const result = spawnSync("ps", ["-o", "pgid=", "-p", `${pid}`], {
    encoding: "utf8",
    timeout: PGRP_TIMEOUT_MS,
    maxBuffer: PGRP_MAX_BUFFER,
  });

  if (result.error) {
    return undefined;
  }

  const stdout = result.stdout?.trim() ?? "";
  if (!stdout) {
    return undefined;
  }

  const pgid = Number(stdout);
  if (!Number.isFinite(pgid)) {
    return undefined;
  }

  return pgid;
}

function recordMockTermination(
  logger: Logger,
  child: ReturnType<typeof spawn>,
  processGroupId: number | undefined,
  onTerminateProcessTree?: (plan: TerminationPlan) => void,
): void {
  const plan = buildTerminationPlan("mock", "SIGTERM", child.pid, processGroupId);
  recordTerminationPlan(logger, onTerminateProcessTree, plan);
}

function recordTerminationPlan(
  logger: Logger,
  onTerminateProcessTree: ((plan: TerminationPlan) => void) | undefined,
  plan: TerminationPlan,
): void {
  onTerminateProcessTree?.(plan);
  if (plan.mode === "mock") {
    logger.info(formatMockTerminationPlan(plan));
  }
}

function buildTerminationPlan(
  mode: "mock" | "real",
  signal: NodeJS.Signals,
  pid: number | undefined,
  processGroupId: number | undefined,
  darwinDescendants?: number[],
): TerminationPlan {
  const platform = process.platform;
  if (!pid) {
    return { mode, platform, signal, strategy: "no-pid" };
  }
  if (platform === "win32") {
    return { mode, platform, signal, pid, strategy: "windows" };
  }
  if (platform === "darwin") {
    const descendants = darwinDescendants ?? collectProcessTreeMacOS(pid);
    return { mode, platform, signal, pid, strategy: "darwin-tree", descendants };
  }
  if (processGroupId) {
    return { mode, platform, signal, pid, processGroupId, strategy: "process-group" };
  }
  return { mode, platform, signal, pid, strategy: "child-only" };
}

function formatMockTerminationPlan(plan: TerminationPlan): string {
  const base = `Mock terminate: ${plan.strategy} pid=${plan.pid ?? "unknown"} signal=${plan.signal}`;
  if (plan.strategy === "darwin-tree") {
    const count = plan.descendants?.length ?? 0;
    return `${base} descendants=${count}`;
  }
  if (plan.strategy === "process-group") {
    return `${base} processGroupId=${plan.processGroupId ?? "unknown"}`;
  }
  return base;
}

function terminateWindowsProcessTree(pid: number): void {
  spawnSync("taskkill", ["/PID", `${pid}`, "/T", "/F"], { stdio: "ignore" });
}

function nextCommandLabel(): string {
  nextCommandId += 1;
  return `[${nextCommandId}]`;
}

function createLineBuffer(emitLine: (line: string) => void): {
  write: (text: string) => void;
  flush: () => void;
} {
  let buffer = "";
  return {
    write(text) {
      if (!text) return;
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        emitLine(`${line}\n`);
      }
    },
    flush() {
      if (!buffer) return;
      emitLine(`${buffer}\n`);
      buffer = "";
    },
  };
}
