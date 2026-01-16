import type { AgentTool } from "../types.ts";

export function buildAgentCommand(
  tool: AgentTool,
  prompt: string,
): {
  commandArgs: [string, ...string[]];
  terminal?: boolean;
  versionCommandArgs: [string, ...string[]];
} {
  switch (tool) {
    case "codex-cli":
      return {
        commandArgs: [
          "npx",
          "--yes",
          "@openai/codex@latest",
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          prompt,
        ],
        versionCommandArgs: ["npx", "--yes", "@openai/codex@latest", "--version"],
      };
    case "octofriend":
      return {
        commandArgs: ["npx", "--yes", "octofriend@latest", "prompt", prompt],
        versionCommandArgs: ["npx", "--yes", "octofriend@latest", "version"],
      };
    case "claude-code":
      return {
        commandArgs: [
          "npx",
          "--yes",
          "@anthropic-ai/claude-code@latest",
          "--dangerously-skip-permissions",
          "--allowed-tools",
          "Bash,Edit,Write",
          "--print",
          prompt,
        ],
        versionCommandArgs: ["npx", "--yes", "@anthropic-ai/claude-code@latest", "--version"],
      };
    case "gemini-cli":
      // "--prompt-interactive" is required to avoid https://github.com/google-gemini/gemini-cli/issues/16567
      return {
        commandArgs: [
          "npx",
          "--yes",
          "@google/gemini-cli@latest",
          "--approval-mode",
          "yolo",
          "--prompt-interactive",
          prompt,
        ],
        versionCommandArgs: ["npx", "--yes", "@google/gemini-cli@latest", "--version"],
        terminal: true,
      };
  }
}
