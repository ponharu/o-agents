import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { logger } from "../../../src/utils/logger.ts";
import { runCommandWithOutput, setCommandConcurrency } from "../../../src/utils/run.ts";

test("runCommandWithOutput prefixes output lines with command id", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "o-agents-run-"));
  const logPath = path.join(tempDir, "run.log");

  try {
    logger.logPath = logPath;
    const script =
      'process.stdout.write("alpha\\nBravo\\n");' +
      'process.stderr.write("err-one\\nerr-two\\n");' +
      'process.stdout.write("tail");';

    await runCommandWithOutput(process.execPath, ["-e", script], {
      cwd: tempDir,
      stream: false,
      throwOnError: true,
    });

    const content = await readFile(logPath, "utf8");
    const commandMatch = content.match(/\[(\d+)\] \$ .*\n/);
    expect(commandMatch).not.toBeNull();

    const commandId = commandMatch?.[1] ?? "";
    const prefix = `[${commandId}]`;

    const mappingMatches = content.match(new RegExp(`\\[${commandId}\\] \\$`, "gm"));
    expect(mappingMatches?.length ?? 0).toBe(1);

    expect(content.indexOf(`${prefix} $`)).toBeLessThan(content.indexOf(`${prefix} alpha`));

    expect(content).toContain(`${prefix} alpha`);
    expect(content).toContain(`${prefix} Bravo`);
    expect(content).toContain(`${prefix} err-one`);
    expect(content).toContain(`${prefix} err-two`);
    expect(content).toContain(`${prefix} tail`);
  } finally {
    logger.logPath = undefined;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCommandWithOutput preserves parent prefix and increments command ids", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "o-agents-run-"));
  const logPath = path.join(tempDir, "run.log");

  try {
    logger.logPath = logPath;

    await logger.runWithContext({ prefix: "[parent]" }, async () => {
      await runCommandWithOutput(process.execPath, ["-e", 'process.stdout.write("first\\n");'], {
        cwd: tempDir,
        stream: false,
        throwOnError: true,
      });
      await runCommandWithOutput(process.execPath, ["-e", 'process.stdout.write("second\\n");'], {
        cwd: tempDir,
        stream: false,
        throwOnError: true,
      });
    });

    const content = await readFile(logPath, "utf8");
    const commandMatches = Array.from(content.matchAll(/\[parent\] \[(\d+)\] \$ /g));

    expect(commandMatches.length).toBe(2);

    const firstId = Number(commandMatches[0]?.[1]);
    const secondId = Number(commandMatches[1]?.[1]);

    expect(secondId).toBeGreaterThan(firstId);
    expect(content).toContain(`[parent] [${firstId}] first`);
    expect(content).toContain(`[parent] [${secondId}] second`);
  } finally {
    logger.logPath = undefined;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("runCommandWithOutput respects command concurrency", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "o-agents-run-"));
  const delayMs = 150;
  const minElapsedMs = delayMs * 1.8;
  const script = `setTimeout(() => { process.stdout.write("done"); }, ${delayMs});`;

  try {
    setCommandConcurrency(1);
    const start = Date.now();
    await Promise.all([
      runCommandWithOutput(process.execPath, ["-e", script], {
        cwd: tempDir,
        stream: false,
        throwOnError: true,
      }),
      runCommandWithOutput(process.execPath, ["-e", script], {
        cwd: tempDir,
        stream: false,
        throwOnError: true,
      }),
    ]);
    const elapsedMs = Date.now() - start;
    // The timing threshold validates serialization without relying on internal pool state.
    expect(elapsedMs).toBeGreaterThan(minElapsedMs);
  } finally {
    setCommandConcurrency(undefined);
    await rm(tempDir, { recursive: true, force: true });
  }
});
