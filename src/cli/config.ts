import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const DEFAULT_CONFIG_FILE = "o-agents/config.toml";

const configSchema = z.object({
  config: z.record(
    z.string(),
    z.object({
      args: z.array(z.string()),
    }),
  ),
});

export type OAgentsConfig = z.infer<typeof configSchema>;

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

  for (const [name, entry] of Object.entries(validated.data.config)) {
    for (const arg of entry.args) {
      if (isDisallowedConfigArg(arg)) {
        throw new Error(
          `Invalid config entry '${name}': '${arg}' is not allowed. ` +
            "Provide --target on the CLI.",
        );
      }
    }
  }

  return validated.data;
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

function isDisallowedConfigArg(arg: string): boolean {
  return arg === "--target" || arg.startsWith("--target=");
}

function formatConfigValidationError(error: z.ZodError, configPath: string): string {
  for (const issue of error.issues) {
    if (issue.path[0] !== "config") {
      continue;
    }
    if (issue.path.length === 1) {
      return `Invalid config file: missing 'config' section in ${configPath}`;
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
  return `Invalid config file: ${error.message}`;
}
