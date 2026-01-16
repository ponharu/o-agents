import type { AgentConfigEntry, OAgentsConfig } from "../config/oAgentsConfig.ts";

export type AgentDefinition = {
  name: string;
  cmd: string[];
  aliases: string[];
  terminal?: boolean;
  versionCmd?: string[];
};

export type AgentRegistry = {
  agents: Map<string, AgentDefinition>;
  aliases: Map<string, string>;
};

const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    name: "codex-cli",
    cmd: [
      "npx",
      "--yes",
      "@openai/codex@latest",
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
    ],
    aliases: ["codex"],
    versionCmd: ["npx", "--yes", "@openai/codex@latest", "--version"],
  },
  {
    name: "claude-code",
    cmd: [
      "npx",
      "--yes",
      "@anthropic-ai/claude-code@latest",
      "--dangerously-skip-permissions",
      "--allowed-tools",
      "Bash,Edit,Write",
      "--print",
    ],
    aliases: ["claude"],
    versionCmd: ["npx", "--yes", "@anthropic-ai/claude-code@latest", "--version"],
  },
  {
    name: "gemini-cli",
    // Required to avoid https://github.com/google-gemini/gemini-cli/issues/16567
    cmd: [
      "npx",
      "--yes",
      "@google/gemini-cli@latest",
      "--approval-mode",
      "yolo",
      "--prompt-interactive",
    ],
    aliases: ["gemini"],
    versionCmd: ["npx", "--yes", "@google/gemini-cli@latest", "--version"],
    terminal: true,
  },
  {
    name: "octofriend",
    cmd: ["npx", "--yes", "octofriend@latest", "prompt"],
    aliases: ["octo"],
    versionCmd: ["npx", "--yes", "octofriend@latest", "version"],
  },
];

export function createAgentRegistry(config?: OAgentsConfig): AgentRegistry {
  const agents = new Map<string, AgentDefinition>();
  for (const agent of BUILTIN_AGENTS) {
    agents.set(agent.name, agent);
  }

  if (config) {
    for (const [name, entry] of Object.entries(config.agents)) {
      const existing = agents.get(name);
      agents.set(name, toAgentDefinition(name, entry, existing));
    }
  }

  const registry: AgentRegistry = {
    agents,
    aliases: new Map(),
  };
  populateAndValidateAliases(registry);
  return registry;
}

export function getAgentChoices(registry: AgentRegistry): string[] {
  return Array.from(registry.agents.keys());
}

export function resolveAgentNameOrAlias(
  registry: AgentRegistry,
  value: string,
): string | undefined {
  const normalized = value.trim();
  if (registry.agents.has(normalized)) return normalized;
  return registry.aliases.get(normalized);
}

export function getAgentDefinition(
  registry: AgentRegistry,
  value: string,
): AgentDefinition | undefined {
  const resolvedName = resolveAgentNameOrAlias(registry, value);
  if (!resolvedName) return undefined;
  return registry.agents.get(resolvedName);
}

export function isAgentNameOrAlias(registry: AgentRegistry, value: string): boolean {
  return resolveAgentNameOrAlias(registry, value) !== undefined;
}

function toAgentDefinition(
  name: string,
  entry: AgentConfigEntry,
  base?: AgentDefinition,
): AgentDefinition {
  return {
    name,
    cmd: entry.cmd,
    aliases: entry.aliases ?? base?.aliases ?? [],
    terminal: entry.terminal ?? base?.terminal,
    versionCmd: entry.versionCmd ?? base?.versionCmd,
  };
}

function populateAndValidateAliases(registry: AgentRegistry): void {
  const agentNames = new Set(registry.agents.keys());

  for (const agent of registry.agents.values()) {
    for (const alias of agent.aliases) {
      if (agentNames.has(alias)) {
        throw new Error(`Invalid agent alias '${alias}': conflicts with agent name '${alias}'.`);
      }
      const existing = registry.aliases.get(alias);
      if (existing) {
        throw new Error(`Invalid agent alias '${alias}': already assigned to '${existing}'.`);
      }
      registry.aliases.set(alias, agent.name);
    }
  }
}
