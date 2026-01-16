import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";

import { resolveNpxCommand } from "../../src/utils/runtime.ts";
import { createTestSubDir } from "../../src/utils/testDir.ts";

test("resolveNpxCommand uses Node runtime instead of Bun", () => {
  const { command } = resolveNpxCommand();
  const result = spawnSync(command, ["-p", "String(Boolean(process.versions?.bun))"], {
    encoding: "utf8",
  });

  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("false");
});

test("resolved npx executes under the Node runtime", () => {
  const { command, args } = resolveNpxCommand();
  const npxPath = args[0];
  if (!npxPath) {
    throw new Error("resolveNpxCommand returned empty args.");
  }
  const result = spawnSync(command, [npxPath, "--version"], { encoding: "utf8" });

  expect(result.status).toBe(0);
  expect((result.stdout || result.stderr || "").trim().length).toBeGreaterThan(0);
});

test("bun --bun can launch octofriend via npx", async () => {
  const tempDir = createTestSubDir("runtime");
  const scriptPath = path.resolve("test/fixtures/launch-octofriend.ts");

  try {
    const npmCacheDir = path.join(tempDir, "npm-cache");
    const result = spawnSync("bun", ["--bun", scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        npm_config_cache: npmCacheDir,
        npm_config_update_notifier: "false",
      },
    });
    if (result.status !== 0) {
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      throw new Error(`octofriend launch failed (status ${result.status}):\n${output}`);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}, 600_000);
