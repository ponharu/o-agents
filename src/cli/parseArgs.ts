import { Command } from "commander";

import type { AgentTool, ParsedArgs, WorkflowSpec } from "../types.ts";
import { getConfigArgs, getConfigNames, loadConfigFile } from "./config.ts";

const AGENT_CHOICES = ["codex-cli", "claude-code", "gemini-cli", "octofriend"] as const;
const AGENT_ALIASES: Record<string, AgentTool> = {
  codex: "codex-cli",
  claude: "claude-code",
  gemini: "gemini-cli",
  octo: "octofriend",
};
const DEFAULT_MAIN_WORKFLOW = "o-agents/workflowNoTest.ts";
const DEFAULT_INIT_COMMAND = "bunx @antfu/ni@latest";

const USAGE = `o-agents

Usage:
  o-agents <config-name> --target <issue/PR>
  o-agents <config-name> --target <issue/PR> --main <agent>  # override config
  o-agents --target <issue/PR> --main <agent> [workflow] [params]
  o-agents --target <issue/PR> --main <agent> [workflow] [params] --compare <agent> [workflow] [params]

Config file (o-agents/config.toml):
  [config.simple]
  args = ["--main", "codex-cli", "--workflow", "o-agents/workflowSimple.ts"]
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
    .option(
      "--init <command>",
      "Initialization command to run in each worktree",
      DEFAULT_INIT_COMMAND,
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

type ConfigInfo = {
  configName?: string;
  remainingArgv: string[];
};

/**
 * Pre-processes argv to extract:
 * - Positional config name (first non-option argument after prefix)
 */
function extractConfigInfo(argv: string[]): ConfigInfo {
  const remainingArgv: string[] = [];
  let configName: string | undefined;
  let i = 0;

  const prefix = argv.slice(0, 2);
  remainingArgv.push(...prefix);
  i = 2;

  while (i < argv.length) {
    const arg = argv[i]!;

    if (!configName && !arg.startsWith("-") && remainingArgv.length === 2) {
      if (!isTargetLike(arg)) {
        configName = arg;
        i++;
        continue;
      }
    }

    remainingArgv.push(arg);
    i++;
  }

  return { configName, remainingArgv };
}

/**
 * Checks if a value looks like a --target value (issue number, PR URL).
 */
function isTargetLike(value: string): boolean {
  if (/^\d+$/.test(value)) return true;
  if (value.startsWith("http://") || value.startsWith("https://")) return true;
  return false;
}

/**
 * Merges config args with CLI args.
 * CLI args take precedence: if an option appears in CLI args, that option
 * is removed from config args before merging.
 */
function mergeArgv(prefix: string[], configArgs: string[], cliArgs: string[]): string[] {
  const cliArgsAfterPrefix = cliArgs.slice(prefix.length);
  const cliOptions = extractOptionNames(cliArgsAfterPrefix);
  const filteredConfigArgs = filterOutOptions(configArgs, cliOptions);
  return [...prefix, ...filteredConfigArgs, ...cliArgsAfterPrefix];
}

/**
 * Extracts option names (e.g., "--main", "--target") from an argv array.
 */
function extractOptionNames(args: string[]): Set<string> {
  const options = new Set<string>();
  for (const arg of args) {
    const optionName = getOptionName(arg);
    if (optionName) {
      options.add(optionName);
    }
  }
  return options;
}

/**
 * Filters out options (and their values) from args that appear in the exclusion set.
 */
function filterOutOptions(args: string[], exclude: Set<string>): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    const optionName = getOptionName(arg);
    if (optionName && exclude.has(optionName)) {
      // Skip this option and all its values (values are non-option args that follow)
      i++;
      if (!arg.includes("=")) {
        while (i < args.length && !args[i]!.startsWith("-")) {
          i++;
        }
      }
    } else {
      result.push(arg);
      i++;
    }
  }
  return result;
}

function getOptionName(arg: string): string | undefined {
  if (!arg.startsWith("--")) {
    return undefined;
  }
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex === -1) {
    return arg;
  }
  return arg.slice(0, equalsIndex);
}

/**
 * Parses argv with configuration file support.
 *
 * Process:
 * 1. Pre-parse argv to extract positional config name
 * 2. Load config file if available
 * 3. If positional arg matches a config name, expand its args
 * 4. Merge: CLI args override config args
 * 5. Call existing parseArgs with merged argv
 */
export function parseArgsWithConfig(argv: string[], configDir: string = process.cwd()): ParsedArgs {
  const { configName, remainingArgv } = extractConfigInfo(argv);
  const config = loadConfigFile(configDir);

  if (configName) {
    if (!config) {
      throw new Error(
        `Config name '${configName}' specified but no config file found. ` +
          "Create o-agents/config.toml in the current directory.",
      );
    }

    const configArgs = getConfigArgs(config, configName);
    if (!configArgs) {
      const available = getConfigNames(config).join(", ");
      throw new Error(
        `Unknown config '${configName}'. Available configs: ${available || "(none)"}`,
      );
    }

    const mergedArgv = mergeArgv(argv.slice(0, 2), configArgs, remainingArgv);
    return parseArgs(mergedArgv);
  }

  return parseArgs(remainingArgv);
}
