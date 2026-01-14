import type { AgentTool } from "../types.ts";
import { hasNodeRuntime } from "../utils/runtime.ts";

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
          "@openai/codex@latest",
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          prompt,
        ],
      };
    case "octofriend":
      return buildOctofriendCommand(prompt);
    case "claude-code":
      return {
        command,
        args: [
          ...argsPrefix,
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
  cachedRunner = hasNodeRuntime()
    ? { command: "npx", argsPrefix: [] }
    : { command: "bunx", argsPrefix: ["--bun"] };
  return cachedRunner;
}

function buildOctofriendCommand(prompt: string): { command: string; args: string[] } {
  if (!hasNodeRuntime()) {
    throw new Error("octofriend requires Node.js to be installed.");
  }
  return {
    command: "npx",
    args: ["--yes", "octofriend@latest", prompt],
  };
}
