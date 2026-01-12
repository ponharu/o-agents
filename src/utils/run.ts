import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { PromisePool } from "minimal-promise-pool";

import type { RunOptions } from "../types.ts";
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
  const { child, exit } = spawnProcessWithLogging(logger, command, args, options);

  try {
    const result = await Promise.race([
      waitForResult,
      exit.then(({ code }) => {
        const exitLabel = code ?? "unknown";
        throw new Error(`Agent exited before posting a result (exit ${exitLabel}).`);
      }),
    ]);

    logger.info(`Received agent result: ${JSON.stringify(result)}`);
    return result;
  } catch (error) {
    await terminateProcessWithTimeout(logger, child, exit);
    throw error;
  }
}

function spawnProcessWithLogging(
  logger: Logger,
  command: string,
  args: string[],
  options: RunOptions,
): {
  child: ReturnType<typeof spawn>;
  output: { stdout: string; stderr: string; combined: string };
  exit: Promise<{ code: number | null }>;
} {
  const streamToConsole = options.stream ?? false;
  const commandId = nextCommandLabel();
  const commandLabel = `$ ${[command, ...args].join(" ")}`;

  return logger.runWithContext({ prefix: commandId }, () => {
    logger.info(commandLabel);

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
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

    return { child, output, exit };
  });
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

async function terminateProcessWithTimeout(
  logger: Logger,
  child: ReturnType<typeof spawn>,
  exit: Promise<{ code: number | null }>,
): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");

  const exited = await Promise.race([exit.then(() => true), setTimeout(5000).then(() => false)]);
  if (exited) return;

  logger.info("Agent did not exit after SIGTERM. Sending SIGKILL...");
  child.kill("SIGKILL");
  await exit;
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
