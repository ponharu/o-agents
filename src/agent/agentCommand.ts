import type { AgentTool } from "../types.ts";

export function buildAgentCommand(
  tool: AgentTool,
  prompt: string,
): { command: string; args: string[] } {
  const { command, argsPrefix } = resolvePackageRunner();
  switch (tool) {
    case "codex-cli":
      return {
        command,
        args: [
          ...argsPrefix,
          "--yes",
          "@openai/codex@latest",
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          prompt,
        ],
      };
    case "claude-code":
      return {
        command,
        args: [
          ...argsPrefix,
          "--yes",
          "@anthropic-ai/claude-code@latest",
          "--dangerously-skip-permissions",
          "--allowed-tools",
          "Bash,Edit,Write",
          "--print",
          prompt,
        ],
      };
    case "gemini-cli":
      return {
        command,
        args: [
          ...argsPrefix,
          "--yes",
          "@google/gemini-cli@latest",
          // Because Gemini CLI frequently gets stuck, we need to debug it more easily.
          "--debug",
          "--approval-mode",
          "yolo",
          "--sandbox",
          "false",
          prompt,
        ],
      };
  }
}

let cachedRunner: { command: string; argsPrefix: string[] } | undefined;

function resolvePackageRunner(): { command: string; argsPrefix: string[] } {
  if (cachedRunner) return cachedRunner;
  cachedRunner = { command: "bunx", argsPrefix: ["--bun"] };
  return cachedRunner;
}
