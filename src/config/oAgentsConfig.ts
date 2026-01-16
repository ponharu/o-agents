import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const DEFAULT_CONFIG_FILE = "o-agents/config.toml";

const configEntrySchema = z.object({
  args: z.array(z.string()),
});

const agentEntrySchema = z.object({
  cmd: z.array(z.string()).min(1),
  aliases: z.array(z.string()).optional(),
  terminal: z.boolean().optional(),
  versionCmd: z.array(z.string()).optional(),
});

const configSchema = z.object({
  config: z.record(z.string(), configEntrySchema).optional(),
  agents: z.record(z.string(), agentEntrySchema).optional(),
});

type ConfigEntry = z.infer<typeof configEntrySchema>;
export type AgentConfigEntry = z.infer<typeof agentEntrySchema>;
export type OAgentsConfig = {
  config: Record<string, ConfigEntry>;
  agents: Record<string, AgentConfigEntry>;
};

/**
 * Loads a config file from the default location in the provided directory.
 * Returns undefined if no config file exists.
 */
export function loadConfigFile(configDir: string = process.cwd()): OAgentsConfig | undefined {
  const configPath = resolve(configDir, DEFAULT_CONFIG_FILE);
  if (!existsSync(configPath)) return;

  const contents = readFileSync(configPath, "utf8");
  const parsed = Bun.TOML.parse(contents) as Record<string, unknown>;
  const validated = configSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(formatConfigValidationError(validated.error, configPath));
  }

  const normalized = normalizeConfig(validated.data);
  validateConfig(normalized, configPath);
  return normalized;
}

/**
 * Returns the args array for a named config.
 * Returns undefined if the config name doesn't exist.
 */
export function getConfigArgs(config: OAgentsConfig, name: string): string[] | undefined {
  const entry = config.config[name];
  return entry?.args;
}

/**
 * Returns available config names for help/error messages.
 */
export function getConfigNames(config: OAgentsConfig): string[] {
  return Object.keys(config.config);
}

function normalizeConfig(config: z.infer<typeof configSchema>): OAgentsConfig {
  return {
    config: config.config ?? {},
    agents: config.agents ?? {},
  };
}

function validateConfig(config: OAgentsConfig, configPath: string): void {
  for (const [name, entry] of Object.entries(config.config)) {
    for (const arg of entry.args) {
      if (isDisallowedConfigArg(arg)) {
        throw new Error(
          `Invalid config entry '${name}': '${arg}' is not allowed. ` +
            "Provide --target on the CLI.",
        );
      }
    }
  }

  validateAgentAliases(config.agents, configPath);
}

function isDisallowedConfigArg(arg: string): boolean {
  return arg === "--target" || arg.startsWith("--target=");
}

function validateAgentAliases(agents: Record<string, AgentConfigEntry>, configPath: string): void {
  const names = new Set(Object.keys(agents));
  const aliasOwners = new Map<string, string>();

  for (const [name, entry] of Object.entries(agents)) {
    const seenAliases = new Set<string>();
    for (const alias of entry.aliases ?? []) {
      if (seenAliases.has(alias)) {
        throw new Error(
          `Invalid agent entry '${name}': duplicate alias '${alias}' in ${configPath}`,
        );
      }
      seenAliases.add(alias);
      if (names.has(alias)) {
        throw new Error(
          `Invalid agent entry '${name}': alias '${alias}' conflicts with agent name in ${configPath}`,
        );
      }
      const existingOwner = aliasOwners.get(alias);
      if (existingOwner) {
        throw new Error(
          `Invalid agent entry '${name}': alias '${alias}' duplicates alias from '${existingOwner}' in ${configPath}`,
        );
      }
      aliasOwners.set(alias, name);
    }
  }
}

function formatConfigValidationError(error: z.ZodError, configPath: string): string {
  for (const issue of error.issues) {
    const section = issue.path[0];
    if (section === "config") {
      if (issue.path.length === 1) {
        return `Invalid config file: 'config' must be a table in ${configPath}`;
      }
      const configName = String(issue.path[1]);
      if (issue.path[2] === "args") {
        if (issue.path.length > 3) {
          return `Invalid config entry '${configName}': all args must be strings`;
        }
        return `Invalid config entry '${configName}': must have 'args' array`;
      }
      return `Invalid config entry '${configName}': must have 'args' array`;
    }
    if (section === "agents") {
      if (issue.path.length === 1) {
        return `Invalid config file: 'agents' must be a table in ${configPath}`;
      }
      const agentName = String(issue.path[1]);
      const field = issue.path[2];
      if (field === "cmd") {
        if (issue.code === "too_small") {
          return `Invalid agent entry '${agentName}': cmd must be a non-empty array`;
        }
        if (issue.path.length > 3) {
          return `Invalid agent entry '${agentName}': all cmd entries must be strings`;
        }
        return `Invalid agent entry '${agentName}': must have 'cmd' array`;
      }
      if (field === "aliases") {
        if (issue.path.length > 3) {
          return `Invalid agent entry '${agentName}': all aliases must be strings`;
        }
        return `Invalid agent entry '${agentName}': aliases must be an array of strings`;
      }
      if (field === "versionCmd") {
        if (issue.path.length > 3) {
          return `Invalid agent entry '${agentName}': all versionCmd entries must be strings`;
        }
        return `Invalid agent entry '${agentName}': versionCmd must be an array of strings`;
      }
      if (field === "terminal") {
        return `Invalid agent entry '${agentName}': terminal must be a boolean`;
      }
    }
  }
  return `Invalid config file: ${error.message}`;
}
