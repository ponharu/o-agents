import { expect, test } from "bun:test";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyTemporaryAgentInstructions,
  restoreTemporaryAgentInstructions,
} from "../../../src/agent/instructionOverride.ts";
import { createTestSubDir } from "../../../src/utils/testDir.ts";

test("applyTemporaryAgentInstructions replaces existing files", async () => {
  const tempDir = createTestSubDir("override");
  const agentsPath = path.join(tempDir, "AGENTS.md");
  const claudePath = path.join(tempDir, "CLAUDE.md");

  try {
    await writeFile(agentsPath, "original agents", "utf8");
    await writeFile(claudePath, "original claude", "utf8");

    await applyTemporaryAgentInstructions("replacement", { cwd: tempDir });

    expect(await readFile(agentsPath, "utf8")).toBe("replacement");
    expect(await readFile(claudePath, "utf8")).toBe("replacement");
  } finally {
    await restoreTemporaryAgentInstructions({ cwd: tempDir });
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("applyTemporaryAgentInstructions skips missing files", async () => {
  const tempDir = createTestSubDir("override");
  const agentsPath = path.join(tempDir, "AGENTS.md");
  const geminiPath = path.join(tempDir, "GEMINI.md");

  try {
    await writeFile(agentsPath, "original agents", "utf8");

    await applyTemporaryAgentInstructions("replacement", { cwd: tempDir });

    expect(await readFile(agentsPath, "utf8")).toBe("replacement");
    expect(await pathExists(geminiPath)).toBe(false);
  } finally {
    await restoreTemporaryAgentInstructions({ cwd: tempDir });
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("restoreTemporaryAgentInstructions restores originals", async () => {
  const tempDir = createTestSubDir("override");
  const agentsPath = path.join(tempDir, "AGENTS.md");

  try {
    await writeFile(agentsPath, "original agents", "utf8");

    await applyTemporaryAgentInstructions("replacement", { cwd: tempDir });
    await restoreTemporaryAgentInstructions({ cwd: tempDir });

    expect(await readFile(agentsPath, "utf8")).toBe("original agents");
  } finally {
    await restoreTemporaryAgentInstructions({ cwd: tempDir });
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("applyTemporaryAgentInstructions restores after timeout", async () => {
  const tempDir = createTestSubDir("override");
  const agentsPath = path.join(tempDir, "AGENTS.md");

  try {
    await writeFile(agentsPath, "original agents", "utf8");

    await applyTemporaryAgentInstructions("replacement", { cwd: tempDir, timeoutMs: 10 });
    await delay(50);

    expect(await readFile(agentsPath, "utf8")).toBe("original agents");
  } finally {
    await restoreTemporaryAgentInstructions({ cwd: tempDir });
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
