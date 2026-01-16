import type { AgentTool } from "../types.ts";
import { type AgentRegistry, createAgentRegistry, getAgentDefinition } from "./agentRegistry.ts";
import { loadConfigFile } from "../config/oAgentsConfig.ts";

const registryCache = new Map<string, AgentRegistry>();

export function buildAgentCommand(
  tool: AgentTool,
  prompt: string,
  configDir: string = process.cwd(),
): {
  commandArgs: [string, ...string[]];
  terminal?: boolean;
  versionCommandArgs?: [string, ...string[]];
} {
  const registry = getRegistry(configDir);
  const definition = getAgentDefinition(registry, tool);
  if (!definition) {
    throw new Error(`Unknown agent tool "${tool}".`);
  }
  const [executable, ...rest] = definition.cmd;
  if (!executable) {
    throw new Error(`Agent '${definition.name}' has an empty cmd array.`);
  }

  const commandArgs: [string, ...string[]] = [executable, ...rest, prompt];
  const versionCommandArgs =
    definition.versionCmd && definition.versionCmd.length > 0
      ? (definition.versionCmd as [string, ...string[]])
      : undefined;

  return {
    commandArgs,
    terminal: definition.terminal,
    versionCommandArgs,
  };
}

function getRegistry(configDir: string): AgentRegistry {
  const cached = registryCache.get(configDir);
  if (cached) {
    return cached;
  }
  const config = loadConfigFile(configDir);
  const registry = createAgentRegistry(config);
  registryCache.set(configDir, registry);
  return registry;
}
