import { execSync, spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

import type { TerminationPlan } from "../types.ts";
import type { Logger } from "./logger.ts";

const PGRP_TIMEOUT_MS = 2000;
const PGRP_MAX_BUFFER = 1024 * 1024;

export async function finalizeAgentProcess(
  logger: Logger,
  child: {
    kill: (signal?: NodeJS.Signals) => boolean;
    pid?: number;
    exitCode: number | null;
    killed: boolean;
  },
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
  child: {
    kill: (signal?: NodeJS.Signals) => boolean;
    pid?: number;
    exitCode: number | null;
    killed: boolean;
  },
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

  const exited = await Promise.race([exit.then(() => true), setTimeout(1000).then(() => false)]);
  if (exited) return;

  logger.info("Agent did not exit after SIGTERM. Sending SIGKILL...");
  signalProcess("SIGKILL");
}

function executeTerminationStrategy(
  plan: TerminationPlan,
  child: {
    kill: (signal?: NodeJS.Signals) => boolean;
    pid?: number;
    exitCode: number | null;
    killed: boolean;
  },
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

function listChildPidsMacOS(parentPid: number, rootPgid?: number): number[] {
  let stdout = "";
  try {
    // We must use execSync due to https://github.com/pkrumins/node-tree-kill/pull/44
    stdout = execSync(`pgrep -P ${parentPid}`, {
      encoding: "utf8",
      timeout: PGRP_TIMEOUT_MS,
      maxBuffer: PGRP_MAX_BUFFER,
    });
  } catch (error) {
    const status = (error as NodeJS.ErrnoException & { status?: number }).status;
    if (status !== 1) {
      return [];
    }
  }

  const trimmed = stdout?.trim() ?? "";
  if (!trimmed) {
    return [];
  }

  const pids = trimmed
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
  let stdout = "";
  try {
    // We must use execSync due to https://github.com/pkrumins/node-tree-kill/pull/44
    stdout = execSync(`ps -o pgid= -p ${pid}`, {
      encoding: "utf8",
      timeout: PGRP_TIMEOUT_MS,
      maxBuffer: PGRP_MAX_BUFFER,
    });
  } catch {
    return undefined;
  }

  const trimmed = stdout?.trim() ?? "";
  if (!trimmed) {
    return undefined;
  }

  const pgid = Number(trimmed);
  return Number.isFinite(pgid) ? pgid : undefined;
}

function recordMockTermination(
  logger: Logger,
  child: {
    kill: (signal?: NodeJS.Signals) => boolean;
    pid?: number;
    exitCode: number | null;
    killed: boolean;
  },
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
  if (processGroupId) {
    return { mode, platform, signal, pid, processGroupId, strategy: "process-group" };
  }
  if (platform === "darwin") {
    const descendants = darwinDescendants ?? collectProcessTreeMacOS(pid);
    return { mode, platform, signal, pid, strategy: "darwin-tree", descendants };
  }
  return { mode, platform, signal, pid, strategy: "child-only" };
}

function formatMockTerminationPlan(plan: TerminationPlan): string {
  const base = `Mock terminate: ${plan.strategy} pid=${plan.pid ?? "unknown"} signal=${plan.signal}`;
  if (plan.strategy === "darwin-tree") {
    return `${base} descendants=${plan.descendants?.length ?? 0}`;
  }
  if (plan.strategy === "process-group") {
    return `${base} processGroupId=${plan.processGroupId ?? "unknown"}`;
  }
  return base;
}

function terminateWindowsProcessTree(pid: number): void {
  spawnSync("taskkill", ["/PID", `${pid}`, "/T", "/F"], { stdio: "ignore" });
}
