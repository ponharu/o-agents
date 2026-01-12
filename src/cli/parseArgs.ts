import { Command } from "commander";

import type { AgentTool, ParsedArgs, WorkflowSpec } from "../types.ts";

const AGENT_CHOICES = ["codex-cli", "claude-code", "gemini-cli"] as const;
const AGENT_ALIASES: Record<string, AgentTool> = {
  codex: "codex-cli",
  claude: "claude-code",
  gemini: "gemini-cli",
};
const DEFAULT_MAIN_WORKFLOW = "o-agents/workflowNoTest.ts";

const USAGE = `o-agents

Usage:
  o-agents --target <issue/PR> --main <agent> [workflow] [params] --compare <agent> [workflow] [params]
  o-agents --target <issue/PR> --main <agent> [workflow] [params]
  o-agents --target <issue/PR> --main <agent>
  o-agents --target <issue/PR> --main <agent> --concurrency <n>
  o-agents --target <issue/PR> --main <agent> --command-concurrency <n>
`;

export function parseArgs(argv: string[]): ParsedArgs {
  const program = new Command();
  program
    .name("o-agents")
    .option("--target <value>", "Target issue/PR number or URL")
    .option("--main <values...>", "Main workflow spec: <agent> [workflow] [params]")
    .option(
      "--concurrency <n>",
      "Max concurrent workflows (main/compare) per agent tool",
      parseConcurrency,
      1,
    )
    .option(
      "--command-concurrency <n>",
      "Max concurrent external commands started by workflows",
      parseConcurrency,
    )
    .option("--compare <values...>", "Comparison workflow spec(s): <agent> [workflow] [params]")
    .showHelpAfterError()
    .allowExcessArguments(false)
    .addHelpText("before", `${USAGE}\n`);

  program.parse(argv);

  const options = program.opts<{
    target?: string;
    main?: string[];
    compare?: string[];
    concurrency: number;
    commandConcurrency?: number;
  }>();
  const target = normalizeTargetValue(options.target);
  if (!target) {
    throw new Error("Provide --target with an issue/PR number or URL.");
  }
  if (!options.main || options.main.length === 0) {
    throw new Error("Provide --main to run a workflow");
  }
  if (
    !Number.isFinite(options.concurrency) ||
    !Number.isInteger(options.concurrency) ||
    options.concurrency <= 0
  ) {
    throw new Error("--concurrency must be a positive integer.");
  }
  if (
    options.commandConcurrency !== undefined &&
    (!Number.isFinite(options.commandConcurrency) ||
      !Number.isInteger(options.commandConcurrency) ||
      options.commandConcurrency <= 0)
  ) {
    throw new Error("--command-concurrency must be a positive integer.");
  }
  const mainSpec = parseWorkflowSpec(options.main, {
    defaultWorkflow: DEFAULT_MAIN_WORKFLOW,
    defaultParams: undefined,
  });
  const compareSpecs = splitCompareValues(options.compare ?? []);
  const compare = compareSpecs.map((spec) =>
    parseWorkflowSpec(spec, {
      defaultWorkflow: mainSpec.workflow,
      defaultParams: mainSpec.params,
    }),
  );

  return {
    target,
    main: mainSpec,
    compare,
    concurrency: options.concurrency,
    commandConcurrency: options.commandConcurrency,
  };
}

function parseConcurrency(value: string): number {
  return Number(value);
}

function parseWorkflowSpec(
  parts: string[],
  defaults?: { defaultWorkflow: string; defaultParams: string | undefined },
): WorkflowSpec {
  if (parts.length === 0) {
    throw new Error("Workflow spec cannot be empty.");
  }

  const [toolRaw, workflow, params] = parts;
  if (!toolRaw) {
    throw new Error("Workflow spec must start with an agent tool.");
  }
  const tool = resolveAgentTool(toolRaw);

  if (!tool) {
    throw new Error(
      `Unknown agent tool "${toolRaw}". Expected one of: ${AGENT_CHOICES.join(", ")}.`,
    );
  }

  if (!workflow) {
    if (!defaults) {
      throw new Error("Workflow spec must be in the form <agent> <workflow> [params].");
    }
    return {
      tool,
      workflow: defaults.defaultWorkflow,
      params: defaults.defaultParams,
    };
  }

  return {
    tool,
    workflow,
    params: params || undefined,
  };
}

function resolveAgentTool(value: string): AgentTool | undefined {
  const normalized = value.trim();
  const mapped = AGENT_ALIASES[normalized] ?? normalized;
  if (isAgentTool(mapped)) {
    return mapped;
  }
  return undefined;
}

function isAgentTool(value: string): value is AgentTool {
  return (AGENT_CHOICES as readonly string[]).includes(value);
}

function isAgentNameOrAlias(value: string): boolean {
  return isAgentTool(value) || value in AGENT_ALIASES;
}

function splitCompareValues(values: string[]): string[][] {
  const specs: string[][] = [];
  let current: string[] = [];

  for (const value of values) {
    if (isAgentNameOrAlias(value)) {
      if (current.length > 0) {
        specs.push(current);
      }
      current = [value];
    } else {
      current.push(value);
    }
  }

  if (current.length > 0) {
    specs.push(current);
  }

  return specs;
}

function normalizeTargetValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}
