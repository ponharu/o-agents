import { z, type ZodType } from "zod";
import { PromisePool } from "minimal-promise-pool";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

import { buildAgentCommand } from "./agentCommand.ts";
import { RESULT_DELIVERY_INSTRUCTION } from "./prompt.ts";
import { startResultServer } from "./resultServer.ts";
import { runAgentUntilResult, runCommandWithOutput } from "../utils/run.ts";
import {
  ensureTemporaryAgentInstructionsApplied,
  restoreTemporaryAgentInstructions,
} from "./instructionOverride.ts";
import type { AgentTool } from "../types.ts";
import { O_AGENTS_LOGS_DIR } from "../git/git.ts";
import { formatRunTimestamp } from "../utils/time.ts";
import { jsonrepair } from "jsonrepair";

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
    const useStdout = tool === "octofriend";
    const resultServer = useStdout ? undefined : await startResultServer(schema);
    const instruction = useStdout
      ? buildStdoutInstruction(schema)
      : buildResponseInstruction(resultServer!.url, schema, cwd).instruction;
    const resolvedPrompt = injectResponseInstruction(prompt, instruction);
    try {
      await ensureTemporaryAgentInstructionsApplied({ cwd });
      const agentCommand = buildAgentCommand(tool, resolvedPrompt);
      if (useStdout) {
        const output = await runCommandWithOutput(agentCommand.command, agentCommand.args, {
          stream: true,
          cwd,
          env: { NODE_ENV: "production" },
          throwOnError: false,
          terminal: agentCommand.terminal,
        });
        const parsed = parseAgentStdout(output.stdout, schema);
        if (parsed === undefined) {
          throw new Error(`Octofriend produced no usable output (exit ${output.exitCode}).`);
        }
        return parsed as T;
      }
      const result = await runAgentUntilResult(
        agentCommand.command,
        agentCommand.args,
        resultServer!.waitForResult,
        {
          stream: true,
          cwd,
          terminal: agentCommand.terminal,
          agentGracePeriodMs: tool === "gemini-cli" ? 0 : undefined,
        },
      );
      return result.result as T;
    } finally {
      await resultServer?.close();
      await restoreTemporaryAgentInstructions({ cwd });
    }
  });
}

function injectResponseInstruction(prompt: string, instruction: string): string {
  if (!prompt.includes(RESULT_DELIVERY_INSTRUCTION)) return prompt;
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

function buildStdoutInstruction(schema: ZodType<unknown> | undefined): string {
  const isJson = Boolean(schema);
  const payloadDescription = isJson
    ? "valid JSON"
    : "plain text (write 'DONE' if no specific result is required)";
  const instructionLines = [
    `Write your response as ${payloadDescription} to stdout only.`,
    "Do not include any other text.",
  ];
  if (!schema) {
    return instructionLines.join("\n");
  }
  const jsonSchema = z.toJSONSchema(schema);
  instructionLines.push(
    "Your JSON response must conform to this schema:",
    "```json",
    JSON.stringify(jsonSchema, null, 2),
    "```",
  );
  return instructionLines.join("\n");
}

function parseAgentStdout<T>(stdout: string, schema: ZodType<T> | undefined): T {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined as T;
  }
  if (!schema) {
    return trimmed as T;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonrepair(trimmed));
  } catch {
    throw new Error("Invalid JSON response from agent.");
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    const issue = validated.error.issues[0]?.message ?? "Invalid result payload.";
    throw new Error(issue);
  }
  return validated.data;
}
