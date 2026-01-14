import { Command } from "commander";

import type { AgentTool, ParsedArgs, WorkflowSpec } from "../types.ts";

const AGENT_CHOICES = ["codex-cli", "claude-code", "gemini-cli", "octofriend"] as const;
const AGENT_ALIASES: Record<string, AgentTool> = {
  codex: "codex-cli",
  claude: "claude-code",
  gemini: "gemini-cli",
  octo: "octofriend",
};
const DEFAULT_MAIN_WORKFLOW = "o-agents/workflowNoTest.ts";
const DEFAULT_INIT_COMMAND = "bunx --bun @antfu/ni@latest";

const USAGE = `o-agents

Usage:
  o-agents --target <issue/PR> --main <agent> [workflow] [params] --compare <agent> [workflow] [params]
  o-agents --target <issue/PR> --main <agent> [workflow] [params]
  o-agents --target <issue/PR> --main <agent>
  o-agents --target <issue/PR> --main <agent> --concurrency <n>
  o-agents --target <issue/PR> --main <agent> --command-concurrency <n>
  o-agents --target <issue/PR> --main <agent> --init <command>
`;

export function parseArgs(argv: string[]): ParsedArgs {
  const resolvedArgv = buildActionArgsFromEnv(process.env, argv) ?? argv;
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
    .option(
      "--init <command>",
      "Initialization command to run in each worktree",
      DEFAULT_INIT_COMMAND,
    )
    .option("--compare <values...>", "Comparison workflow spec(s): <agent> [workflow] [params]")
    .showHelpAfterError()
    .allowExcessArguments(false)
    .addHelpText("before", `${USAGE}\n`);

  program.parse(resolvedArgv);

  const options = program.opts<{
    target?: string;
    main?: string[];
    compare?: string[];
    concurrency: number;
    commandConcurrency?: number;
    init: string;
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
    initCommand: options.init,
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

function buildActionArgsFromEnv(env: NodeJS.ProcessEnv, argv: string[]): string[] | undefined {
  if (!env.GITHUB_ACTIONS) {
    return undefined;
  }
  const hasFlags = argv.slice(2).some((arg) => arg.startsWith("--"));
  if (hasFlags) {
    return undefined;
  }

  const target = normalizeTargetValue(env.INPUT_TARGET);
  if (!target) {
    return undefined;
  }

  const args: string[] = ["--target", target];
  const main = normalizeTargetValue(env.INPUT_MAIN) ?? "codex-cli";
  args.push("--main", main);

  const workflow = normalizeTargetValue(env.INPUT_WORKFLOW);
  const params = normalizeTargetValue(env.INPUT_PARAMS);
  if (workflow) {
    args.push(workflow);
    if (params) {
      args.push(params);
    }
  }

  const compare = normalizeTargetValue(env.INPUT_COMPARE);
  if (compare) {
    args.push("--compare", ...compare.split(/\s+/).filter(Boolean));
  }

  const concurrency = normalizeTargetValue(env.INPUT_CONCURRENCY);
  if (concurrency) {
    args.push("--concurrency", concurrency);
  }

  const commandConcurrency = normalizeTargetValue(env.INPUT_COMMAND_CONCURRENCY);
  if (commandConcurrency) {
    args.push("--command-concurrency", commandConcurrency);
  }

  const init = normalizeTargetValue(env.INPUT_INIT);
  if (init) {
    args.push("--init", init);
  }

  const baseArgs = argv.slice(0, 2).filter((arg): arg is string => Boolean(arg));
  return [...baseArgs, ...args];
}
