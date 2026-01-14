import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { logger } from "../../../src/utils/logger.ts";
import type { TerminationPlan } from "../../../src/types.ts";
import {
  runAgentUntilResult,
  runCommandWithOutput,
  setCommandConcurrency,
} from "../../../src/utils/run.ts";

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

test("runAgentUntilResult logs intended process tree termination after result", async () => {
  if (process.platform === "win32") return;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "o-agents-run-"));
  const pidFile = path.join(tempDir, "child.pid");
  const terminationPlans: TerminationPlan[] = [];
  const script = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    "const pidFile = process.env.PID_FILE;",
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });',
    "writeFileSync(pidFile, String(child.pid));",
    'setTimeout(() => { try { child.kill("SIGTERM"); } catch {} process.exit(0); }, 200);',
    "setInterval(() => {}, 1000);",
  ].join("");

  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "test";
    const waitForResult = (async () => {
      await readFileWhenReady(pidFile);
      return { result: "ok", receivedAt: new Date().toISOString() };
    })();

    await runAgentUntilResult(process.execPath, ["-e", script], waitForResult, {
      cwd: tempDir,
      env: { PID_FILE: pidFile },
      stream: false,
      agentGracePeriodMs: 50,
      mockTerminateProcessTree: true,
      onTerminateProcessTree: (plan) => terminationPlans.push(plan),
    });

    const childPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(childPid).toBeGreaterThan(0);
    expect(terminationPlans.length).toBeGreaterThan(0);
    const plan = terminationPlans[0];
    if (!plan) {
      throw new Error("Expected a termination plan to be recorded.");
    }
    expect(plan.mode).toBe("mock");
    expect(plan.signal).toBe("SIGTERM");
    expect(plan.pid ?? 0).toBeGreaterThan(0);
  } finally {
    process.env.NODE_ENV = previousNodeEnv;
    await rm(tempDir, { recursive: true, force: true });
  }
});

async function readFileWhenReady(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (attempt >= 49) {
        throw error;
      }
      await sleep(10);
    }
  }
  return "";
}
