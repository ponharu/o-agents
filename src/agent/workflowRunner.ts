import { z, type ZodType } from "zod";
import { PromisePool } from "minimal-promise-pool";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

import { buildAgentCommand } from "./agentCommand.ts";
import { RESULT_DELIVERY_INSTRUCTION } from "./prompt.ts";
import { startResultServer } from "./resultServer.ts";
import { runAgentUntilResult } from "../utils/run.ts";
import {
  ensureTemporaryAgentInstructionsApplied,
  restoreTemporaryAgentInstructions,
} from "./instructionOverride.ts";
import type { AgentRunOptions, AgentTool } from "../types.ts";
import { O_AGENTS_LOGS_DIR } from "../git/git.ts";
import { formatRunTimestamp } from "../utils/time.ts";

let agentConcurrency = 1;
const promisePools = new Map<AgentTool, PromisePool>();

export function setAgentConcurrency(value: number): void {
  agentConcurrency = value;
  promisePools.clear();
}

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
    const instruction = buildResponseInstruction(resultServer.url, schema, cwd).instruction;
    const resolvedPrompt = injectResponseInstruction(prompt, instruction);
    try {
      await ensureTemporaryAgentInstructionsApplied({ cwd });
      const agentCommand = buildAgentCommand(tool, resolvedPrompt);
      const agentRunOptions: AgentRunOptions = {
        stream: true,
        cwd,
        terminal: agentCommand.terminal,
        agentGracePeriodMs: 5000,
      };
      const result = await runAgentUntilResult(
        agentCommand.command,
        agentCommand.args,
        resultServer.waitForResult,
        agentRunOptions,
      );
      return result.result as T;
    } finally {
      await resultServer?.close();
      await restoreTemporaryAgentInstructions({ cwd });
    }
  });
}

function injectResponseInstruction(prompt: string, instruction: string): string {
  if (!prompt.includes(RESULT_DELIVERY_INSTRUCTION)) return prompt + "\n\n" + instruction;
  return prompt.replaceAll(RESULT_DELIVERY_INSTRUCTION, instruction);
}

function getPromisePool(tool: AgentTool): PromisePool {
  let pool = promisePools.get(tool);
  if (!pool) {
    pool = new PromisePool(agentConcurrency);
    promisePools.set(tool, pool);
  }
  return pool;
}

function buildResponseInstruction(
  callbackUrl: string,
  schema: ZodType<unknown> | undefined,
  cwd: string,
): { instruction: string; logFilePath: string } {
  const timestamp = formatRunTimestamp();
  const logsBaseDir = join(cwd, O_AGENTS_LOGS_DIR, "response");
  const logFilePath = join(logsBaseDir, `${timestamp}.log`);
  mkdirSync(logsBaseDir, { recursive: true });
  const isJson = Boolean(schema);
  const payloadDescription = isJson
    ? "valid JSON"
    : "plain text (write 'DONE' if no specific result is required)";
  const instructionLines = [
    `Write your response to "${logFilePath}" as ${payloadDescription} and submit it using this curl command (retry until successful):`,
  ];
  const contentType = isJson ? "application/json" : "text/plain";
  instructionLines.push(
    "```bash",
    `curl -sS -X POST -H "Content-Type: ${contentType}" --data-binary @"${logFilePath}" ${callbackUrl}`,
    "```",
  );
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
