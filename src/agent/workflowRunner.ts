import { z, type ZodType } from "zod";
import { PromisePool } from "minimal-promise-pool";
import { join } from "node:path";

import { buildAgentCommand } from "./agentCommand.ts";
import { RESULT_DELIVERY_INSTRUCTION } from "./prompt.ts";
import { startResultServer } from "./resultServer.ts";
import { runAgentUntilResult } from "../utils/run.ts";
import {
  ensureTemporaryAgentInstructionsApplied,
  restoreTemporaryAgentInstructions,
} from "./instructionOverride.ts";
import type { AgentTool } from "../types.ts";
import { O_AGENTS_DIR } from "../git/git.ts";
import { formatRunTimestamp } from "../utils/time.ts";
import { mkdirSync } from "node:fs";

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
    const resultServer = await startResultServer(schema);
    const resolvedPrompt = injectCallbackPrompt(prompt, resultServer.url, schema);
    try {
      await ensureTemporaryAgentInstructionsApplied({ cwd });
      const agentCommand = buildAgentCommand(tool, resolvedPrompt);
      const result = await runAgentUntilResult(
        agentCommand.command,
        agentCommand.args,
        resultServer.waitForResult,
        {
          stream: true,
          cwd,
        },
      );
      return result.result as T;
    } finally {
      await resultServer.close();
      await restoreTemporaryAgentInstructions({ cwd });
    }
  });
}

function injectCallbackPrompt(
  prompt: string,
  callbackUrl: string,
  schema: ZodType<unknown> | undefined,
): string {
  const hasPlaceholder = prompt.includes(RESULT_DELIVERY_INSTRUCTION);
  if (!hasPlaceholder) return prompt;
  const responseInstruction = buildResponseInstruction(callbackUrl, schema);
  return prompt.replaceAll(RESULT_DELIVERY_INSTRUCTION, responseInstruction);
}

function buildResponseInstruction(
  callbackUrl: string,
  schema: ZodType<unknown> | undefined,
): string {
  const logDirPath = join(O_AGENTS_DIR, "logs");
  const logFilePath = join(logDirPath, `${formatRunTimestamp()}-response.log`);
  mkdirSync(logDirPath, { recursive: true });
  if (!schema) {
    return [
      `Write your response to "${logFilePath}" as plain text and submit it using this curl command (retry until successful):`,
      "```bash",
      `curl -sS -X POST -H "Content-Type: text/plain" --data-binary @"${logFilePath}" ${callbackUrl}`,
      "```",
    ].join("\n");
  }
  const jsonSchema = z.toJSONSchema(schema);
  return [
    `Write your response to "${logFilePath}" as valid JSON and submit it using this curl command (retry until successful):`,
    "```bash",
    `curl -sS -X POST -H "Content-Type: application/json" --data-binary @"${logFilePath}" ${callbackUrl}`,
    "```",
    `Your JSON response must conform to this schema:`,
    "```json",
    JSON.stringify(jsonSchema, null, 2),
    "```",
  ].join("\n");
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
