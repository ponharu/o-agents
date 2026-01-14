import type { AgentTool } from "../types.ts";

export function buildAgentCommand(
  tool: AgentTool,
  prompt: string,
): { command: string; args: string[] } {
  switch (tool) {
    case "codex-cli":
      return {
        command: "bunx",
        args: [
          "--bun",
          "@openai/codex@latest",
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          prompt,
        ],
      };
    case "claude-code":
      return {
        command: "bunx",
        args: [
          "--bun",
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
        command: "bunx",
        args: [
          "--bun",
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
