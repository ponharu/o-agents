import type { AgentTool } from "../types.ts";

export function buildAgentCommand(
  tool: AgentTool,
  prompt: string,
): { command: string; args: string[]; terminal?: boolean } {
  switch (tool) {
    case "codex-cli":
      return {
        command: "npx",
        args: [
          "--yes",
          "@openai/codex@latest",
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          prompt,
        ],
      };
    case "octofriend":
      return {
        command: "npx",
        args: ["--yes", "octofriend@latest", "prompt", prompt],
      };
    case "claude-code":
      return {
        command: "npx",
        args: [
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
      // "--prompt-interactive" is required to avoid https://github.com/google-gemini/gemini-cli/issues/16567
      return {
        command: "npx",
        args: [
          "--yes",
          "@google/gemini-cli@latest",
          "--approval-mode",
          "yolo",
          "--prompt-interactive",
          prompt,
        ],
        terminal: true,
      };
  }
}
