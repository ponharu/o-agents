import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

let cachedNodeRuntime: boolean | undefined;
let cachedNodeBinary: string | undefined;
let cachedNpxBinary: string | undefined;

export function hasNodeRuntime(): boolean {
  if (cachedNodeRuntime === undefined) {
    cachedNodeRuntime = resolveNodeBinary() !== undefined;
  }
  return cachedNodeRuntime;
}

/**
 * Resolve the command used to run npx under a real Node runtime.
 *
 * Bun's `--bun` mode ignores shebangs, so we force `node <npx>` to keep CLIs on Node.
 */
export function resolveNpxCommand(): { command: string; args: string[] } {
  const nodeBinary = getNodeBinary();
  const npxBinary = resolveNpxBinary(nodeBinary);
  if (!npxBinary) {
    throw new Error("Unable to locate npx on PATH; install npm or add npx to PATH.");
  }
  return { command: nodeBinary, args: [npxBinary] };
}

function getNodeBinary(): string {
  const nodeBinary = resolveNodeBinary();
  if (!nodeBinary) {
    throw new Error("Node.js is required to run agents via npx.");
  }
  return nodeBinary;
}

function resolveNodeBinary(): string | undefined {
  if (cachedNodeBinary) return cachedNodeBinary;

  for (const candidate of listPathCandidates("node")) {
    const runtimeInfo = getNodeRuntimeInfo(candidate);
    if (!runtimeInfo || runtimeInfo.isBun || !runtimeInfo.execPath) {
      continue;
    }
    cachedNodeBinary = runtimeInfo.execPath;
    return cachedNodeBinary;
  }
  return undefined;
}

function resolveNpxBinary(nodeBinary: string): string | undefined {
  if (cachedNpxBinary) return cachedNpxBinary;
  const npxFromNode = resolveNpxFromNodeBinary(nodeBinary);
  if (npxFromNode) {
    cachedNpxBinary = npxFromNode;
    return cachedNpxBinary;
  }
  for (const candidate of buildCandidates([dirname(nodeBinary)], "npx")) {
    if (existsSync(candidate) && isNodeRunnableScript(nodeBinary, candidate)) {
      cachedNpxBinary = candidate;
      return cachedNpxBinary;
    }
  }
  for (const candidate of listPathCandidates("npx")) {
    if (isNodeRunnableScript(nodeBinary, candidate)) {
      cachedNpxBinary = candidate;
      return cachedNpxBinary;
    }
  }
  return undefined;
}

function resolveNpxFromNodeBinary(nodeBinary: string): string | undefined {
  const result = spawnSync(nodeBinary, ["-p", "require.resolve('npm/bin/npx-cli.js')"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0 || !result.stdout) {
    return undefined;
  }
  const resolved = result.stdout.trim();
  if (!resolved || !existsSync(resolved)) {
    return undefined;
  }
  return resolved;
}

function getNodeRuntimeInfo(command: string): { execPath?: string; isBun?: boolean } | undefined {
  const result = spawnSync(
    command,
    ["-p", "JSON.stringify({ execPath: process.execPath, isBun: Boolean(process.versions?.bun) })"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  if (result.error || result.status !== 0 || !result.stdout) {
    return undefined;
  }
  try {
    return JSON.parse(result.stdout.trim()) as { execPath?: string; isBun?: boolean };
  } catch {
    return undefined;
  }
}

function isNodeRunnableScript(nodeBinary: string, scriptPath: string): boolean {
  const result = spawnSync(nodeBinary, [scriptPath, "--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function listPathCandidates(command: string): string[] {
  const pathValue = process.env.PATH ?? "";
  if (!pathValue) return [];
  const pathParts = pathValue.split(delimiter).filter(Boolean);
  return buildCandidates(pathParts, command);
}

function buildCandidates(directories: string[], command: string): string[] {
  return directories.map((directory) => join(directory, command));
}
