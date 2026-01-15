import { spawn } from "node:child_process";
import { PromisePool } from "minimal-promise-pool";

import type { AgentRunOptions, RunOptions } from "../types.ts";
import { type LogContext, type Logger, logger } from "./logger.ts";
import type { AgentResult } from "../agent/resultServer.ts";
import { finalizeAgentProcess } from "./terminate.ts";

const DEFAULT_OUTPUT_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

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
  options: AgentRunOptions,
): Promise<AgentResult<unknown>> {
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_OUTPUT_INACTIVITY_TIMEOUT_MS;
  let child!: ReturnType<typeof spawnProcessWithLogging>["child"];
  let exit!: ReturnType<typeof spawnProcessWithLogging>["exit"];
  let processGroupId: ReturnType<typeof spawnProcessWithLogging>["processGroupId"];
  let inactivityError: Error | undefined;
  let watchdogTimer: NodeJS.Timeout | undefined;
  let watchdogReject: ((error: Error) => void) | undefined;
  let terminationPromise: Promise<void> | undefined;
  const requestTermination = (gracePeriodMs: number) => {
    if (!terminationPromise) {
      terminationPromise = finalizeAgentProcess(
        logger,
        child,
        exit,
        gracePeriodMs,
        processGroupId,
        options.mockTerminateProcessTree,
        options.onTerminateProcessTree,
      );
    }
    return terminationPromise;
  };
  const clearWatchdog = () => {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = undefined;
    }
  };
  const formatInactivityLabel = () => {
    if (inactivityTimeoutMs >= 60_000 && inactivityTimeoutMs % 60_000 === 0) {
      const minutes = inactivityTimeoutMs / 60_000;
      return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    }
    if (inactivityTimeoutMs >= 1000 && inactivityTimeoutMs % 1000 === 0) {
      const seconds = inactivityTimeoutMs / 1000;
      return `${seconds} second${seconds === 1 ? "" : "s"}`;
    }
    return `${inactivityTimeoutMs}ms`;
  };
  const resetWatchdog = () => {
    if (!watchdogReject) return;
    clearWatchdog();
    watchdogTimer = setTimeout(() => {
      if (inactivityError) return;
      const message = `No output received from agent for ${formatInactivityLabel()}; terminating process tree.`;
      inactivityError = new Error(message);
      logger.error(message);
      const reject = watchdogReject;
      if (reject) {
        reject(inactivityError);
      }
      void requestTermination(0);
    }, inactivityTimeoutMs);
  };
  ({ child, exit, processGroupId } = spawnProcessWithLogging(
    logger,
    command,
    args,
    options,
    { detached: true },
    resetWatchdog,
  ));
  let result: AgentResult<unknown> | undefined;
  let failure: unknown;
  const watchdogPromise =
    inactivityTimeoutMs > 0
      ? new Promise<AgentResult<unknown>>((_, reject) => {
          watchdogReject = reject;
          resetWatchdog();
        })
      : undefined;

  try {
    result = await Promise.race([
      waitForResult,
      exit.then(({ code }) => {
        throw new Error(`Agent exited before posting a result (exit ${code ?? "unknown"}).`);
      }),
      ...(watchdogPromise ? [watchdogPromise] : []),
    ]);
    logger.info(`Received agent result: ${JSON.stringify(result)}`);
  } catch (error) {
    failure = error;
  } finally {
    clearWatchdog();
  }

  await requestTermination(options.agentGracePeriodMs);

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
  onOutputActivity?: () => void,
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
    return runWithTerminalLoggingContext(logger, command, args, (prefix, context) =>
      spawnProcessWithTerminal(
        command,
        args,
        options,
        spawnOptions,
        onOutputActivity,
        prefix,
        context,
      ),
    );
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
      onOutputActivity?.();
      output.stdout += text;
      output.combined += text;
      stdoutBuffer.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      onOutputActivity?.();
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
  onOutputActivity?: () => void,
  prefix?: string,
  context?: LogContext,
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
  const streamToConsole = options.stream ?? false;
  const output = { stdout: "", stderr: "", combined: "" };
  const decoder = new TextDecoder();
  const writeChunk = createPrefixedChunkWriter(logger, prefix, context);
  let lastLine = "";
  const recentLines: string[] = [];
  const recentLineSet = new Set<string>();
  const rememberLine = (line: string) => {
    recentLines.push(line);
    recentLineSet.add(line);
    if (recentLines.length > 12) {
      const removed = recentLines.shift();
      if (removed && !recentLines.includes(removed)) {
        recentLineSet.delete(removed);
      }
    }
  };
  const stdoutBuffer = createLineBuffer((line) => {
    const normalizedLine = normalizeTerminalLine(line);
    if (!normalizedLine) return;
    if (normalizedLine === lastLine) return;
    if (recentLineSet.has(normalizedLine)) return;
    lastLine = normalizedLine;
    rememberLine(normalizedLine);
    writeChunk(normalizedLine, streamToConsole, false);
  });

  const terminal = new Bun.Terminal({
    cols: 120,
    rows: 40,
    data(_terminal, data) {
      const text = decoder.decode(data, { stream: true });
      if (!text) return;
      onOutputActivity?.();
      output.stdout += text;
      output.combined += text;
      const normalizedChunk = normalizeTerminalChunk(text);
      if (normalizedChunk) {
        stdoutBuffer.write(normalizedChunk);
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
      const normalizedChunk = normalizeTerminalChunk(flushText);
      if (normalizedChunk) {
        stdoutBuffer.write(normalizedChunk);
      }
    }
    stdoutBuffer.flush();
    closeTerminalSafely(terminal);
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
}

function normalizeTerminalChunk(text: string): string {
  const withoutAnsi = stripAnsi(text);
  const stripped = stripDanglingAnsi(withoutAnsi);
  const withoutOsc = stripDanglingOsc(stripped);
  return stripNoiseControls(withoutOsc).replace(/\r/g, "\n");
}

function closeTerminalSafely(terminal: Bun.Terminal): void {
  if (terminal.closed) return;
  terminal.close();
}

function runWithTerminalLoggingContext<T>(
  logger: Logger,
  command: string,
  args: string[],
  fn: (prefix: string, context: LogContext) => T,
): T {
  const commandId = nextCommandLabel();
  const commandLabel = `$ ${[command, ...args].join(" ")}`;
  const context = logger.getContextSnapshot();
  logger.info(`${commandId} ${commandLabel}`);
  return fn(commandId, context);
}

function createPrefixedChunkWriter(
  logger: Logger,
  prefix: string | undefined,
  context?: LogContext,
): (chunk: string, streamToConsole: boolean, isError: boolean) => void {
  const writeWithContext = context
    ? (chunk: string, streamToConsole: boolean, isError: boolean) =>
        logger.writeChunkWithContext(chunk, streamToConsole, isError, context)
    : (chunk: string, streamToConsole: boolean, isError: boolean) =>
        logger.writeChunk(chunk, streamToConsole, isError);
  if (!prefix) {
    return writeWithContext;
  }
  return (chunk, streamToConsole, isError) =>
    writeWithContext(prefixChunk(chunk, prefix), streamToConsole, isError);
}

function prefixChunk(text: string, prefix: string): string {
  const normalizedPrefix = prefix.endsWith(" ") ? prefix : `${prefix} `;
  return text
    .split("\n")
    .map((line) => (line ? `${normalizedPrefix}${line}` : line))
    .join("\n");
}

function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;?]*[ -/]*[@-~]/g,
    "",
  );
}

function stripDanglingAnsi(text: string): string {
  return text
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\[38;[0-9; ]+m?/g, "")
    .replace(/;?\d{1,3}(?:;\d{1,3})+m/g, "")
    .replace(/;?\d{1,3}m/g, "");
}

function stripDanglingOsc(text: string): string {
  return text.replace(/\][0-9;?][^\s]*/g, "");
}

function stripNoiseControls(text: string): string {
  const withoutControls = text.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,
    "",
  );
  return withoutControls.replace(/[\u2800-\u28ff]/g, "");
}

function normalizeTerminalLine(line: string): string | undefined {
  const trimmed = stripPrefixArtifacts(line).trim();
  const normalized = normalizeWhitespace(trimmed);
  if (!normalized) {
    return undefined;
  }
  if (!/[A-Za-z0-9]/.test(normalized)) {
    return undefined;
  }
  if (isBannedLine(normalized)) return undefined;
  if (isAsciiArtLine(normalized)) return undefined;
  if (isMostlyDecorativeLine(normalized)) return undefined;
  if (isBoxDrawingLine(normalized)) return undefined;
  if (isDigitsOnly(normalized)) return undefined;
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function stripPrefixArtifacts(text: string, preserveInner = false): string {
  const normalized = preserveInner ? text : text.replace(/(\[\d+\]\s*)+/g, "");
  return normalized.replace(/^(\[\d+\]\s*)+/, "").trim();
}

function normalizeWhitespace(text: string): string {
  const withoutParens = text.replace(/\([^)]*\)/g, "");
  const withoutMarkers = withoutParens.replace(/[⊶✓]/g, "");
  return withoutMarkers.replace(/\s+/g, " ").trim();
}

function isBannedLine(line: string): boolean {
  const normalized = line.toLowerCase();
  const bannedFragments = [
    "gemini.md file yolo mode",
    "type your message or @path/to/file",
    "no sandbox auto /model",
    "if you're using an ide, see the context with ctrl+g",
    "refining the approach",
    "structuring the response",
    "reflecting on initial steps",
    "defining the response strategy",
    "disambiguating output destinations",
    "interpreting the instructions",
    "deciphering the intent",
    "finalizing the strategy",
    "finalizing the response",
    "clarifying the response flow",
    "i'm feeling lucky",
  ];
  return bannedFragments.some((fragment) => normalized.includes(fragment));
}

function isBoxDrawingLine(line: string): boolean {
  return /^[\s╭╮╰╯│─┼┴┬├┤]+$/.test(line);
}

function isAsciiArtLine(line: string): boolean {
  return /^[\s█░]+$/.test(line);
}

function isMostlyDecorativeLine(line: string): boolean {
  const trimmed = line.replace(/\s+/g, "");
  if (trimmed.length < 8) return false;
  const decorativeChars = /[█░╭╮╰╯│─┼┴┬├┤]/g;
  const total = trimmed.length;
  const decorativeCount = (trimmed.match(decorativeChars) || []).length;
  return decorativeCount / total >= 0.8;
}

function isDigitsOnly(line: string): boolean {
  return /^\d+$/.test(line);
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
