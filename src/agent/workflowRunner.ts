import { z, type ZodType } from "zod";
import { PromisePool } from "minimal-promise-pool";
import { join } from "node:path";
import { readFile, unlink } from "node:fs/promises";

import { buildAgentCommand } from "./agentCommand.ts";
import { RESULT_DELIVERY_INSTRUCTION } from "./prompt.ts";
import { startResultServer, type ResultServer } from "./resultServer.ts";
import { runAgentUntilResult, runCommandWithOutput } from "../utils/run.ts";
import {
  ensureTemporaryAgentInstructionsApplied,
  restoreTemporaryAgentInstructions,
} from "./instructionOverride.ts";
import type { AgentTool } from "../types.ts";
import { O_AGENTS_DIR } from "../git/git.ts";
import { formatRunTimestamp } from "../utils/time.ts";
import { mkdirSync } from "node:fs";
import { jsonrepair } from "jsonrepair";

let agentConcurrency = 1;
const promisePools = new Map<AgentTool, PromisePool>();

type RunNonInteractiveAgentsOptions<T> = {
  tools: AgentTool[];
  prompt: string;
  cwd: string;
  schema?: ZodType<T>;
};

export async function runNonInteractiveAgents(
  options: RunNonInteractiveAgentsOptions<string>,
): Promise<string[]>;
export async function runNonInteractiveAgents<T>(
  options: RunNonInteractiveAgentsOptions<T> & { schema: ZodType<T> },
): Promise<T[]>;
export async function runNonInteractiveAgents<T>(
  options: RunNonInteractiveAgentsOptions<T>,
): Promise<T[]> {
  const { tools, prompt, cwd } = options;
  const seenTools = new Set<AgentTool>();
  const uniqueTools = tools.filter((tool) => {
    if (seenTools.has(tool)) return false;
    seenTools.add(tool);
    return true;
  });
  const schema = options.schema;
  if (schema) {
    return Promise.all(
      uniqueTools.map((tool) => runNonInteractiveAgent({ tool, prompt, cwd, schema })),
    );
  }
  return Promise.all(
    uniqueTools.map((tool) => runNonInteractiveAgent({ tool, prompt, cwd })),
  ) as Promise<T[]>;
}

type RunNonInteractiveAgentOptions<T> = {
  tool: AgentTool;
  prompt: string;
  cwd: string;
  schema?: ZodType<T>;
};

type ResponseMode = "callback" | "file";
type ResponseHandling = {
  responseMode: ResponseMode;
  instruction: string;
  logFilePath: string;
  resultServer?: ResultServer<unknown>;
};

export async function runNonInteractiveAgent(
  options: RunNonInteractiveAgentOptions<string>,
): Promise<string>;
export async function runNonInteractiveAgent<T>(
  options: RunNonInteractiveAgentOptions<T> & { schema: ZodType<T> },
): Promise<T>;
export async function runNonInteractiveAgent<T>(
  options: RunNonInteractiveAgentOptions<T>,
): Promise<T> {
  const pool = getPromisePool(options.tool);
  return pool.runAndWaitForReturnValue(async () => {
    const { tool, prompt, cwd } = options;
    const schema = options.schema as ZodType<T> | undefined;
    const responseHandling = await resolveResponseHandling(tool, schema, cwd);
    const resolvedPrompt = injectResponseInstruction(prompt, responseHandling.instruction);
    try {
      await ensureTemporaryAgentInstructionsApplied({ cwd });
      const agentCommand = buildAgentCommand(tool, resolvedPrompt);
      return await runAgentWithResponse(agentCommand, responseHandling, schema, cwd);
    } finally {
      await responseHandling.resultServer?.close();
      await restoreTemporaryAgentInstructions({ cwd });
    }
  });
}

function injectResponseInstruction(prompt: string, responseInstruction: string): string {
  const hasPlaceholder = prompt.includes(RESULT_DELIVERY_INSTRUCTION);
  if (!hasPlaceholder) return prompt;
  return prompt.replaceAll(RESULT_DELIVERY_INSTRUCTION, responseInstruction);
}

export function setAgentConcurrency(value: number): void {
  agentConcurrency = value;
  promisePools.clear();
}

function getPromisePool(tool: AgentTool): PromisePool {
  let pool = promisePools.get(tool);
  if (!pool) {
    pool = new PromisePool(agentConcurrency);
    promisePools.set(tool, pool);
  }
  return pool;
}

async function resolveResponseHandling(
  tool: AgentTool,
  schema: ZodType<unknown> | undefined,
  cwd: string,
): Promise<ResponseHandling> {
  const responseMode = resolveResponseMode(tool);
  if (responseMode === "file") {
    return {
      responseMode,
      ...buildResponseInstruction(responseMode, undefined, schema, cwd),
    };
  }
  const resultServer = await startResultServer(schema);
  return {
    responseMode,
    ...buildResponseInstruction(responseMode, resultServer.url, schema, cwd),
    resultServer,
  };
}

async function runAgentWithResponse<T>(
  agentCommand: { command: string; args: string[] },
  responseHandling: ResponseHandling,
  schema: ZodType<T> | undefined,
  cwd: string,
): Promise<T> {
  if (responseHandling.responseMode === "file") {
    await runCommandWithOutput(agentCommand.command, agentCommand.args, {
      stream: true,
      cwd,
      throwOnError: true,
    });
    const result = await readAgentResultFromFile(responseHandling.logFilePath, schema);
    await removeResponseFile(responseHandling.logFilePath);
    return result;
  }
  if (!responseHandling.resultServer) {
    throw new Error("Missing result server for callback response mode.");
  }
  const result = await runAgentUntilResult(
    agentCommand.command,
    agentCommand.args,
    responseHandling.resultServer.waitForResult,
    {
      stream: true,
      cwd,
    },
  );
  return result.result as T;
}

function resolveResponseMode(tool: AgentTool): ResponseMode {
  // Gemini CLI frequently fails to run curl commands, so it writes responses to a file.
  return tool === "gemini-cli" ? "file" : "callback";
}

function buildResponseInstruction(
  responseMode: ResponseMode,
  callbackUrl: string | undefined,
  schema: ZodType<unknown> | undefined,
  cwd: string,
): { instruction: string; logFilePath: string } {
  const timestamp = formatRunTimestamp();
  const logDirPath = join(cwd, O_AGENTS_DIR, "logs");
  const logFilePath =
    responseMode === "file"
      ? join(cwd, `.o-agents-response-${timestamp}.log`)
      : join(logDirPath, `${timestamp}-response.log`);
  if (responseMode === "callback") {
    mkdirSync(logDirPath, { recursive: true });
  }
  if (responseMode === "callback" && !callbackUrl) {
    throw new Error("Callback URL is required for callback response mode.");
  }
  const isJson = Boolean(schema);
  const payloadDescription = isJson ? "valid JSON" : "plain text";
  const instructionLines = [
    responseMode === "file"
      ? `Write your response to "${logFilePath}" as ${payloadDescription}, then terminate.`
      : `Write your response to "${logFilePath}" as ${payloadDescription} and submit it using this curl command (retry until successful):`,
  ];
  if (responseMode === "callback") {
    const contentType = isJson ? "application/json" : "text/plain";
    instructionLines.push(
      "```bash",
      `curl -sS -X POST -H "Content-Type: ${contentType}" --data-binary @"${logFilePath}" ${callbackUrl}`,
      "```",
    );
  }
  if (!schema) {
    return { instruction: instructionLines.join("\n"), logFilePath };
  }

  const jsonSchema = z.toJSONSchema(schema);
  instructionLines.push(
    `Your JSON response must conform to this schema:`,
    "```json",
    JSON.stringify(jsonSchema, null, 2),
    "```",
  );
  return {
    instruction: instructionLines.join("\n"),
    logFilePath,
  };
}

async function readAgentResultFromFile<T>(
  logFilePath: string,
  schema: ZodType<T> | undefined,
): Promise<T> {
  let contents: string;
  try {
    contents = await readFile(logFilePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read agent response file "${logFilePath}": ${message}`);
  }

  const trimmed = contents.trim();
  if (!schema) {
    return trimmed as T;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonrepair(trimmed));
  } catch {
    throw new Error(`Invalid JSON response file "${logFilePath}".`);
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    const issue = validated.error.issues[0]?.message ?? "Invalid result payload.";
    throw new Error(issue);
  }
  return validated.data;
}

async function removeResponseFile(logFilePath: string): Promise<void> {
  try {
    await unlink(logFilePath);
  } catch {
    // Ignore cleanup failures; the response was already captured.
  }
}
