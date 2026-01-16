import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfigFile,
  getConfigArgs,
  getConfigNames,
} from "../../../src/config/oAgentsConfig.ts";

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

  test("loadConfigFile parses agent definitions", () => {
    writeConfig(`
[agents.custom]
cmd = ["custom", "--flag"]
aliases = ["c"]
terminal = true
versionCmd = ["custom", "--version"]
`);

    const config = loadConfigFile(TEST_DIR);
    expect(config).toBeDefined();
    expect(config?.agents.custom?.cmd).toEqual(["custom", "--flag"]);
    expect(config?.agents.custom?.aliases).toEqual(["c"]);
    expect(config?.agents.custom?.terminal).toBe(true);
    expect(config?.agents.custom?.versionCmd).toEqual(["custom", "--version"]);
  });

  test("loadConfigFile allows agents without config presets", () => {
    writeConfig(`
[agents.only]
cmd = ["agent"]
`);

    const config = loadConfigFile(TEST_DIR);
    expect(config).toBeDefined();
    expect(getConfigNames(config!)).toEqual([]);
  });

  test("loadConfigFile returns empty config and agents for unrecognized sections", () => {
    writeConfig(`
[other]
key = "value"
`);

    const config = loadConfigFile(TEST_DIR);
    expect(config).toBeDefined();
    expect(config!.config).toEqual({});
    expect(config!.agents).toEqual({});
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

  test("loadConfigFile throws on missing agent cmd", () => {
    writeConfig(`
[agents.bad]
aliases = ["nope"]
`);

    expect(() => loadConfigFile(TEST_DIR)).toThrow("must have 'cmd' array");
  });

  test("loadConfigFile throws on empty agent cmd", () => {
    writeConfig(`
[agents.bad]
cmd = []
`);

    expect(() => loadConfigFile(TEST_DIR)).toThrow("cmd must be a non-empty array");
  });

  test("loadConfigFile throws on non-string aliases", () => {
    writeConfig(`
[agents.bad]
cmd = ["agent"]
aliases = [123]
`);

    expect(() => loadConfigFile(TEST_DIR)).toThrow("all aliases must be strings");
  });

  test("loadConfigFile throws on duplicate aliases", () => {
    writeConfig(`
[agents.one]
cmd = ["agent"]
aliases = ["dup"]

[agents.two]
cmd = ["agent"]
aliases = ["dup"]
`);

    expect(() => loadConfigFile(TEST_DIR)).toThrow("duplicates alias");
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
