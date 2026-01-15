import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigFile, getConfigArgs, getConfigNames } from "../../../src/cli/config.ts";

const TEST_DIR = join(import.meta.dir, ".test-config");
const CONFIG_DIR = join(TEST_DIR, "o-agents");
const CONFIG_PATH = join(CONFIG_DIR, "config.toml");

describe("config", () => {
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

  test("loadConfigFile returns undefined when no config exists", () => {
    const config = loadConfigFile(TEST_DIR);
    expect(config).toBeUndefined();
  });

  test("loadConfigFile parses valid TOML config", () => {
    writeConfig(`
[config.simple]
args = ["--main", "codex-cli", "--workflow", "o-agents/workflowSimple.ts"]

[config.test]
args = ["--main", "codex-cli", "--workflow", "o-agents/workflowWithTests.ts"]
`);

    const config = loadConfigFile(TEST_DIR);
    expect(config).toBeDefined();
    expect(getConfigNames(config!)).toEqual(["simple", "test"]);
  });

  test("getConfigArgs returns correct args for named config", () => {
    writeConfig(`
[config.myconfig]
args = ["--main", "claude-code", "--concurrency", "2"]
`);

    const config = loadConfigFile(TEST_DIR);
    const args = getConfigArgs(config!, "myconfig");
    expect(args).toEqual(["--main", "claude-code", "--concurrency", "2"]);
  });

  test("getConfigArgs returns undefined for non-existent config name", () => {
    writeConfig(`
[config.exists]
args = ["--main", "codex"]
`);

    const config = loadConfigFile(TEST_DIR);
    const args = getConfigArgs(config!, "nonexistent");
    expect(args).toBeUndefined();
  });

  test("loadConfigFile throws on missing config section", () => {
    writeConfig(`
[other]
key = "value"
`);

    expect(() => loadConfigFile(TEST_DIR)).toThrow("missing 'config' section");
  });

  test("loadConfigFile throws on missing args array", () => {
    writeConfig(`
[config.bad]
notargs = ["--main", "codex"]
`);

    expect(() => loadConfigFile(TEST_DIR)).toThrow("must have 'args' array");
  });

  test("loadConfigFile throws on non-string args", () => {
    writeConfig(`
[config.bad]
args = [123, "--main"]
`);

    expect(() => loadConfigFile(TEST_DIR)).toThrow("all args must be strings");
  });

  test("loadConfigFile throws on disallowed args", () => {
    writeConfig(`
[config.bad]
args = ["--target", "123", "--main", "codex-cli"]
`);

    expect(() => loadConfigFile(TEST_DIR)).toThrow("not allowed");
  });

  test("getConfigNames returns empty array for empty config", () => {
    writeConfig(`
[config]
`);

    const config = loadConfigFile(TEST_DIR);
    expect(getConfigNames(config!)).toEqual([]);
  });
});

function writeConfig(contents: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, contents);
}
