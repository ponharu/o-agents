import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildAgentCommand } from "../../../src/agent/agentCommand.ts";
import { createTestSubDir } from "../../../src/utils/testDir.ts";

test("buildAgentCommand appends prompt and preserves terminal flag", () => {
  const tempDir = createTestSubDir("agent-command");
  try {
    writeConfig(
      tempDir,
      `
[agents.custom]
cmd = ["custom", "--flag"]
aliases = ["c"]
terminal = true
versionCmd = ["custom", "--version"]
`,
    );

    const command = buildAgentCommand("custom", "hello world", tempDir);
    expect(command.commandArgs).toEqual(["custom", "--flag", "hello world"]);
    expect(command.terminal).toBe(true);
    expect(command.versionCommandArgs).toEqual(["custom", "--version"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("buildAgentCommand omits version args when not configured", () => {
  const tempDir = createTestSubDir("agent-command");
  try {
    writeConfig(
      tempDir,
      `
[agents.noversion]
cmd = ["noversion"]
`,
    );

    const command = buildAgentCommand("noversion", "prompt", tempDir);
    expect(command.commandArgs).toEqual(["noversion", "prompt"]);
    expect(command.versionCommandArgs).toBeUndefined();
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeConfig(baseDir: string, contents: string): void {
  const configDir = join(baseDir, "o-agents");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.toml"), contents);
}
