import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { logger } from "../utils/logger.ts";
import { getErrorMessage } from "../utils/error.ts";

const INSTRUCTION_FILENAMES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;
const DEFAULT_TIMEOUT_MS = 30_000;

type OverrideState = {
  cwd?: string;
  originalContents: Map<string, string>;
  active: boolean;
  timeoutId?: ReturnType<typeof setTimeout>;
  restoring?: Promise<void>;
  replacement?: string;
  handlersRegistered: boolean;
};

const overrideState: OverrideState = {
  originalContents: new Map(),
  active: false,
  handlersRegistered: false,
};

export async function applyTemporaryAgentInstructions(
  replacement: string,
  options: { cwd: string; timeoutMs?: number },
): Promise<void> {
  const { cwd } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (overrideState.active && overrideState.cwd && overrideState.cwd !== cwd) {
    await restoreTemporaryAgentInstructions({ cwd: overrideState.cwd });
  }

  overrideState.cwd = cwd;
  overrideState.replacement = replacement;

  const instructionPaths = INSTRUCTION_FILENAMES.map((filename) => join(cwd, filename));
  for (const filePath of instructionPaths) {
    const existing = await readFileIfExists(filePath);
    if (existing === undefined) {
      continue;
    }
    if (!overrideState.originalContents.has(filePath)) {
      overrideState.originalContents.set(filePath, existing);
    }
    await writeFile(filePath, replacement, "utf8");
  }

  overrideState.active = overrideState.originalContents.size > 0;
  if (!overrideState.active) {
    return;
  }

  registerProcessHandlers();
  refreshTimeout(timeoutMs);
}

export async function ensureTemporaryAgentInstructionsApplied(options: {
  cwd: string;
}): Promise<void> {
  if (!overrideState.active || overrideState.replacement === undefined) {
    return;
  }
  if (isCwdMismatch(options.cwd, overrideState.cwd)) {
    return;
  }
  const { cwd } = options;
  const instructionPaths = INSTRUCTION_FILENAMES.map((filename) => join(cwd, filename));

  for (const filePath of instructionPaths) {
    if (!overrideState.originalContents.has(filePath)) {
      continue;
    }
    const current = await readFileIfExists(filePath);
    if (current === undefined) {
      continue;
    }
    if (current !== overrideState.replacement) {
      await writeFile(filePath, overrideState.replacement, "utf8");
    }
  }
}

export async function restoreTemporaryAgentInstructions(options: { cwd: string }): Promise<void> {
  if (!overrideState.active) return;
  if (isCwdMismatch(options.cwd, overrideState.cwd)) {
    return;
  }
  if (overrideState.restoring) {
    await overrideState.restoring;
    return;
  }

  overrideState.restoring = (async () => {
    for (const [filePath, contents] of overrideState.originalContents.entries()) {
      try {
        await writeFile(filePath, contents, "utf8");
      } catch (error) {
        const message = getErrorMessage(error);
        logger.error(`Failed to restore ${filePath}: ${message}`);
      }
    }
    clearTimeoutIfNeeded();
    overrideState.originalContents.clear();
    overrideState.active = false;
    overrideState.cwd = undefined;
    overrideState.replacement = undefined;
  })();

  try {
    await overrideState.restoring;
  } finally {
    overrideState.restoring = undefined;
  }
}

function registerProcessHandlers(): void {
  if (overrideState.handlersRegistered) return;
  overrideState.handlersRegistered = true;

  process.once("exit", () => {
    void restoreTemporaryAgentInstructions({ cwd: overrideState.cwd ?? process.cwd() }).catch(
      (error) => {
        const message = getErrorMessage(error);
        logger.error(`Failed to restore instructions on exit: ${message}`);
      },
    );
  });

  registerSignalHandler("SIGINT");
  registerSignalHandler("SIGTERM");
}

function registerSignalHandler(signal: NodeJS.Signals): void {
  const handler = () => {
    process.off(signal, handler);
    void restoreTemporaryAgentInstructions({ cwd: overrideState.cwd ?? process.cwd() })
      .catch((error) => {
        const message = getErrorMessage(error);
        logger.error(`Failed to restore instructions on ${signal}: ${message}`);
      })
      .finally(() => {
        process.kill(process.pid, signal);
      });
  };
  process.on(signal, handler);
}

function refreshTimeout(timeoutMs: number): void {
  clearTimeoutIfNeeded();
  const normalizedMs = Math.max(0, timeoutMs);
  overrideState.timeoutId = setTimeout(() => {
    void restoreTemporaryAgentInstructions({ cwd: overrideState.cwd ?? process.cwd() }).catch(
      (error) => {
        const message = getErrorMessage(error);
        logger.error(`Failed to restore instructions after timeout: ${message}`);
      },
    );
  }, normalizedMs);
}

function clearTimeoutIfNeeded(): void {
  if (!overrideState.timeoutId) return;
  clearTimeout(overrideState.timeoutId);
  overrideState.timeoutId = undefined;
}

async function readFileIfExists(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return undefined;
    }
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function isCwdMismatch(requestedCwd: string, activeCwd: string | undefined): boolean {
  return Boolean(activeCwd && requestedCwd !== activeCwd);
}
