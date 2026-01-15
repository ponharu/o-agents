import type { AgentTool } from "../types.ts";
import { hasNodeRuntime } from "../utils/runtime.ts";

export function buildAgentCommand(
  tool: AgentTool,
  prompt: string,
): { command: string; args: string[]; terminal?: boolean } {
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
      if (!hasNodeRuntime()) {
        throw new Error("octofriend requires Node.js to be installed.");
      }
      return { command: "npx", args: ["--yes", "octofriend@latest", "prompt", prompt] };
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
      // "--output-format stream-json" is required to avoid https://github.com/google-gemini/gemini-cli/issues/16567
      return {
        command,
        args: [
          ...argsPrefix,
          "@google/gemini-cli@latest",
          "--approval-mode",
          "yolo",
          "--output-format",
          "stream-json",
          "--prompt-interactive",
          prompt,
        ],
        terminal: true,
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
