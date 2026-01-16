import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseArgs, parseArgsWithConfig } from "../../../src/cli/parseArgs.ts";

const DEFAULT_WORKFLOW = "o-agents/workflowNoTest.ts";
const TEST_DIR = join(import.meta.dir, ".test-parseargs");
const CONFIG_DIR = join(TEST_DIR, "o-agents");
const CONFIG_PATH = join(CONFIG_DIR, "config.toml");

test("parseArgs requires --target", () => {
  const argv = ["node", "o-agents", "--main", "codex-cli", "o-agents/workflowWithTests.ts"];
  expect(() => parseArgs(argv)).toThrow("Provide --target with an issue/PR number or URL.");
});

test("parseArgs maps agent aliases to canonical tools", () => {
  const argv = [
    "node",
    "o-agents",
    "--target",
    "123",
    "--main",
    "codex",
    "o-agents/workflowWithTests.ts",
  ];
  const parsed = parseArgs(argv);
  expect(parsed.main?.tool).toBe("codex-cli");
});

test("parseArgs defaults shorthand main workflow", () => {
  const argv = ["node", "o-agents", "--target", "123", "--main", "codex"];
  const parsed = parseArgs(argv);
  expect(parsed.main?.tool).toBe("codex-cli");
  expect(parsed.main?.workflow).toBe(DEFAULT_WORKFLOW);
  expect(parsed.main?.params).toBeUndefined();
  expect(parsed.concurrency).toBe(1);
  expect(parsed.commandConcurrency).toBeUndefined();
});

test("parseArgs inherits main workflow and params for shorthand compare", () => {
  const argv = [
    "node",
    "o-agents",
    "--target",
    "123",
    "--main",
    "codex-cli",
    "o-agents/workflowWithTests.ts",
    '{"foo":1}',
    "--compare",
    "gemini",
  ];
  const parsed = parseArgs(argv);
  expect(parsed.main?.workflow).toBe("o-agents/workflowWithTests.ts");
  expect(parsed.main?.params).toBe('{"foo":1}');
  expect(parsed.compare).toBeDefined();
  const compare = parsed.compare?.[0];
  expect(compare).toBeDefined();
  expect(compare?.tool).toBe("gemini-cli");
  expect(compare?.workflow).toBe(parsed.main?.workflow);
  expect(compare?.params).toBe(parsed.main?.params);
});

test("parseArgs accepts multiple compare flags", () => {
  const argv = [
    "node",
    "o-agents",
    "--target",
    "49",
    "--main",
    "codex",
    "o-agents/workflowWithTests.ts",
    "--compare",
    "claude",
    "--compare",
    "gemini",
  ];
  const parsed = parseArgs(argv);

  expect(parsed.target).toBe("49");
  expect(parsed.compare).toHaveLength(2);
  expect(parsed.compare?.[0]?.tool).toBe("claude-code");
  expect(parsed.compare?.[1]?.tool).toBe("gemini-cli");
});

test("parseArgs rejects typos in agent tool names", () => {
  const argv = ["node", "o-agents", "--target", "123", "--main", "codexx"];
  expect(() => parseArgs(argv)).toThrow(
    'Unknown agent tool "codexx". Expected one of: codex-cli, claude-code, gemini-cli, octofriend.',
  );
});

test("parseArgs rejects non-positive concurrency", () => {
  const argvBase = ["node", "o-agents", "--target", "123", "--main", "codex"];
  expect(() => parseArgs([...argvBase, "--concurrency", "0"])).toThrow(
    "--concurrency must be a positive integer.",
  );
  expect(() => parseArgs([...argvBase, "--concurrency", "-1"])).toThrow(
    "--concurrency must be a positive integer.",
  );
});

test("parseArgs rejects non-positive command concurrency", () => {
  const argvBase = ["node", "o-agents", "--target", "123", "--main", "codex"];
  expect(() => parseArgs([...argvBase, "--command-concurrency", "0"])).toThrow(
    "--command-concurrency must be a positive integer.",
  );
  expect(() => parseArgs([...argvBase, "--command-concurrency", "-1"])).toThrow(
    "--command-concurrency must be a positive integer.",
  );
});

describe("parseArgsWithConfig", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  test("parseArgsWithConfig expands config name to args", () => {
    writeConfig(`
[config.simple]
args = ["--main", "codex-cli"]
`);

    const argv = ["node", "o-agents", "simple", "--target", "123"];
    const parsed = parseArgsWithConfig(argv, TEST_DIR);
    expect(parsed.main?.tool).toBe("codex-cli");
    expect(parsed.target).toBe("123");
  });

  test("parseArgsWithConfig supports custom agents and aliases", () => {
    writeConfig(`
[config.simple]
args = ["--main", "my-agent", "o-agents/workflowWithTests.ts"]

[agents.my-agent]
cmd = ["my-agent"]
aliases = ["my"]
`);

    const argv = ["node", "o-agents", "simple", "--target", "123", "--compare", "my"];
    const parsed = parseArgsWithConfig(argv, TEST_DIR);
    expect(parsed.main?.tool).toBe("my-agent");
    expect(parsed.compare?.[0]?.tool).toBe("my-agent");
  });

  test("parseArgsWithConfig CLI args override config args", () => {
    writeConfig(`
[config.simple]
args = ["--main", "codex-cli"]
`);

    const argv = ["node", "o-agents", "simple", "--target", "123", "--main", "claude-code"];
    const parsed = parseArgsWithConfig(argv, TEST_DIR);
    expect(parsed.main?.tool).toBe("claude-code");
  });

  test("parseArgsWithConfig throws for unknown config name", () => {
    writeConfig(`
[config.simple]
args = ["--main", "codex"]
`);

    const argv = ["node", "o-agents", "unknown", "--target", "123"];
    expect(() => parseArgsWithConfig(argv, TEST_DIR)).toThrow(
      "Unknown config 'unknown'. Available configs:",
    );
  });

  test("parseArgsWithConfig works without config file", () => {
    const argv = ["node", "o-agents", "--target", "123", "--main", "codex-cli"];
    const parsed = parseArgsWithConfig(argv, TEST_DIR);
    expect(parsed.main?.tool).toBe("codex-cli");
    expect(parsed.target).toBe("123");
  });

  test("parseArgsWithConfig throws when config name specified but no config file", () => {
    const argv = ["node", "o-agents", "simple", "--target", "123"];
    expect(() => parseArgsWithConfig(argv, TEST_DIR)).toThrow(
      "Config name 'simple' specified but no config file found.",
    );
  });
});

function writeConfig(contents: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, contents);
}
