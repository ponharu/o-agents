import { appendFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

export type LogContext = {
  extraLogPaths?: string[];
  mainPrefix?: string;
  prefix?: string;
  logPath?: string;
};

export class Logger {
  logPath?: string;
  private extraLogPaths = new Set<string>();
  private context = new AsyncLocalStorage<LogContext>();

  constructor(logPath?: string) {
    this.logPath = logPath;
  }

  info(message: string, options: { console?: boolean } = {}): void {
    const rawLine = normalizeLine(message);
    const context = this.getContext();
    const baseLine = applyPrefixToText(rawLine, context.prefix);
    const mainLine = applyPrefixToText(rawLine, mergePrefixes(context.mainPrefix, context.prefix));
    if (options.console !== false) {
      process.stdout.write(mainLine);
    }
    this.appendToFile({ mainLine, baseLine, rawLine, context });
  }

  error(message: string): void {
    const rawLine = normalizeLine(message);
    const context = this.getContext();
    const baseLine = applyPrefixToText(rawLine, context.prefix);
    const mainLine = applyPrefixToText(rawLine, mergePrefixes(context.mainPrefix, context.prefix));
    process.stderr.write(mainLine);
    this.appendToFile({ mainLine, baseLine, rawLine, context });
  }

  writeChunk(chunk: string, streamToConsole: boolean, isError: boolean): void {
    if (!chunk) return;
    const context = this.getContext();
    const baseText = applyPrefixToText(chunk, context.prefix);
    const mainText = applyPrefixToText(chunk, mergePrefixes(context.mainPrefix, context.prefix));
    if (streamToConsole) {
      if (isError) {
        process.stderr.write(mainText);
      } else {
        process.stdout.write(mainText);
      }
    }
    this.appendToFile({ mainLine: mainText, baseLine: baseText, rawLine: chunk, context });
  }

  writeChunkWithContext(
    chunk: string,
    streamToConsole: boolean,
    isError: boolean,
    context: LogContext,
  ): void {
    if (!chunk) return;
    const baseText = applyPrefixToText(chunk, context.prefix);
    const mainText = applyPrefixToText(chunk, mergePrefixes(context.mainPrefix, context.prefix));
    if (streamToConsole) {
      if (isError) {
        process.stderr.write(mainText);
      } else {
        process.stdout.write(mainText);
      }
    }
    this.appendToFile({ mainLine: mainText, baseLine: baseText, rawLine: chunk, context });
  }

  getContextSnapshot(): LogContext {
    return this.getContext();
  }

  logPrompt(label: string, prompt: string, limit = 4000): void {
    const { text, truncated } = formatPromptForLog(prompt, limit);
    const lengthLabel = truncated ? "truncated" : "full";
    this.info(`${label} (${prompt.length} chars, ${lengthLabel}):\n${text}`);
    if (truncated) {
      this.info(`${label} (full ${prompt.length} chars):\n${prompt}`, { console: false });
    }
  }

  runWithContext<T>(context: LogContext, fn: () => Promise<T>): Promise<T>;
  runWithContext<T>(context: LogContext, fn: () => T): T;
  runWithContext<T>(context: LogContext, fn: () => Promise<T> | T): Promise<T> | T {
    const mergedContext = mergeLogContext(this.getContext(), context);
    return this.context.run(mergedContext, fn);
  }

  private appendToFile({
    mainLine,
    baseLine,
    rawLine,
    context,
  }: {
    mainLine: string;
    baseLine: string;
    rawLine: string;
    context: LogContext;
  }): void {
    const mainLogPath = context.logPath ?? this.logPath;
    if (mainLogPath) {
      appendFileSync(mainLogPath, mainLine);
    }
    const extraLogPaths = new Set<string>([
      ...this.extraLogPaths,
      ...(context.extraLogPaths ?? []),
    ]);
    const extraLine = context.mainPrefix ? baseLine : rawLine;
    for (const logPath of extraLogPaths) {
      appendFileSync(logPath, extraLine);
    }
  }

  private getContext(): LogContext {
    return this.context.getStore() ?? {};
  }
}

export const logger = new Logger();

function normalizeLine(message: string): string {
  return message.endsWith("\n") ? message : `${message}\n`;
}

function formatPromptForLog(prompt: string, limit: number): { text: string; truncated: boolean } {
  const safeLimit = Math.max(0, limit);
  if (prompt.length <= safeLimit) {
    return { text: prompt, truncated: false };
  }
  const remaining = prompt.length - safeLimit;
  return {
    text: `${prompt.slice(0, safeLimit)}\n... [truncated ${remaining} chars]`,
    truncated: true,
  };
}

function applyPrefixToText(text: string, prefix: string | undefined): string {
  if (!prefix) return text;
  const normalizedPrefix = prefix.endsWith(" ") ? prefix : `${prefix} `;
  return text
    .split("\n")
    .map((line) => (line ? `${normalizedPrefix}${line}` : line))
    .join("\n");
}

function mergeLogContext(parent: LogContext, child: LogContext): LogContext {
  return {
    extraLogPaths: mergeLogPaths(parent.extraLogPaths, child.extraLogPaths),
    mainPrefix: mergePrefixes(parent.mainPrefix, child.mainPrefix),
    prefix: mergePrefixes(parent.prefix, child.prefix),
    logPath: mergeLogPath(parent.logPath, child.logPath),
  };
}

function mergeLogPath(parent?: string, child?: string): string | undefined {
  return child ?? parent;
}

function mergeLogPaths(parent?: string[], child?: string[]): string[] | undefined {
  const merged = [...(parent ?? []), ...(child ?? [])];
  return merged.length > 0 ? merged : undefined;
}

function mergePrefixes(parent?: string, child?: string): string | undefined {
  if (parent && child) {
    return `${parent} ${child}`;
  }
  return parent ?? child;
}
