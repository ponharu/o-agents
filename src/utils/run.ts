import { spawn } from "node:child_process";
import { PromisePool } from "minimal-promise-pool";

import type { RunOptions } from "../types.ts";
import { logger, type Logger } from "./logger.ts";
import type { AgentResult } from "../agent/resultServer.ts";
import { finalizeAgentProcess } from "./terminate.ts";

let nextCommandId = 0;
let commandPromisePool: PromisePool | undefined;

export function setCommandConcurrency(value?: number): void {
  if (value === undefined) {
    commandPromisePool = undefined;
    return;
  }
  commandPromisePool = new PromisePool(value);
}

export async function runCommandWithOutput(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<{ stdout: string; stderr: string; combined: string; exitCode: number }> {
  const run = async () => {
    const { exit, output } = spawnProcessWithLogging(logger, command, args, options);
    const { code } = await exit;
    if (code !== 0 && options.throwOnError) {
      throw new Error(formatCommandFailureMessage(command, args, code, output.stderr));
    }
    return { ...output, exitCode: code ?? 0 };
  };
  return commandPromisePool ? commandPromisePool.runAndWaitForReturnValue(run) : run();
}

export async function runAgentUntilResult(
  command: string,
  args: string[],
  waitForResult: Promise<AgentResult<unknown>>,
  options: RunOptions,
): Promise<AgentResult<unknown>> {
  const { child, exit, processGroupId } = spawnProcessWithLogging(logger, command, args, options, {
    detached: true,
  });
  const gracePeriodMs = options.agentGracePeriodMs ?? 30_000;

  let result: AgentResult<unknown> | undefined;
  let failure: unknown;

  try {
    result = await Promise.race([
      waitForResult,
      exit.then(({ code }) => {
        throw new Error(`Agent exited before posting a result (exit ${code ?? "unknown"}).`);
      }),
    ]);
    logger.info(`Received agent result: ${JSON.stringify(result)}`);
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

  if (failure) throw failure;
  return result!;
}

function runWithLoggingContext<T>(logger: Logger, command: string, args: string[], fn: () => T): T {
  const commandId = nextCommandLabel();
  const commandLabel = `$ ${[command, ...args].join(" ")}`;

  return logger.runWithContext({ prefix: commandId }, () => {
    logger.info(commandLabel);
    return fn();
  });
}

function spawnProcessWithLogging(
  logger: Logger,
  command: string,
  args: string[],
  options: RunOptions,
  spawnOptions?: { detached?: boolean },
): {
  child: {
    kill: (signal?: NodeJS.Signals) => boolean;
    pid?: number;
    exitCode: number | null;
    killed: boolean;
  };
  output: { stdout: string; stderr: string; combined: string };
  exit: Promise<{ code: number | null }>;
  processGroupId?: number;
} {
  if (options.terminal) {
    return spawnProcessWithTerminal(command, args, options, spawnOptions);
  }

  return runWithLoggingContext(logger, command, args, () => {
    const streamToConsole = options.stream ?? false;
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
    return {
      child: {
        kill: (signal?: NodeJS.Signals) => child.kill(signal),
        pid: child.pid,
        get exitCode() {
          return child.exitCode;
        },
        get killed() {
          return child.killed;
        },
      },
      output,
      exit,
      processGroupId,
    };
  });
}

function spawnProcessWithTerminal(
  command: string,
  args: string[],
  options: RunOptions,
  spawnOptions?: { detached?: boolean },
): {
  child: {
    kill: (signal?: NodeJS.Signals) => boolean;
    pid?: number;
    exitCode: number | null;
    killed: boolean;
  };
  output: { stdout: string; stderr: string; combined: string };
  exit: Promise<{ code: number }>;
  processGroupId?: number;
} {
  return runWithLoggingContext(logger, command, args, () => {
    const streamToConsole = options.stream ?? false;
    const output = { stdout: "", stderr: "", combined: "" };
    const decoder = new TextDecoder();
    const stdoutBuffer = createLineBuffer((line) => {
      logger.writeChunk(line, streamToConsole, false);
    });

    const terminal = new Bun.Terminal({
      cols: 120,
      rows: 40,
      data(_terminal, data) {
        const text = decoder.decode(data, { stream: true });
        if (!text) return;
        output.stdout += text;
        output.combined += text;
        const displayText = normalizeTerminalOutput(stripAnsi(text));
        if (displayText) {
          stdoutBuffer.write(displayText);
        }
      },
    });

    const detached = spawnOptions?.detached ?? false;
    const child = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      terminal,
      detached,
    });

    const exit = child.exited.then((exitCode) => {
      const flushText = decoder.decode();
      if (flushText) {
        output.stdout += flushText;
        output.combined += flushText;
        const displayText = normalizeTerminalOutput(stripAnsi(flushText));
        if (displayText) {
          stdoutBuffer.write(displayText);
        }
      }
      stdoutBuffer.flush();
      return { code: exitCode };
    });

    const processGroupId = detached ? (child.pid ?? undefined) : undefined;
    return {
      child: {
        kill: (signal?: NodeJS.Signals) => {
          child.kill(signal);
          return true;
        },
        pid: child.pid,
        get exitCode() {
          return child.exitCode;
        },
        get killed() {
          return child.exitCode !== null;
        },
      },
      output,
      exit,
      processGroupId,
    };
  });
}

function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;?]*[ -/]*[@-~]/g,
    "",
  );
}

function normalizeTerminalOutput(text: string): string {
  return text.replace(/\r/g, "\n");
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
