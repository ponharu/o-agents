import { spawnSync } from "node:child_process";

let cachedNodeRuntime: boolean | undefined;

export function hasNodeRuntime(): boolean {
  if (cachedNodeRuntime === undefined) {
    cachedNodeRuntime = hasRuntime("node");
  }
  return cachedNodeRuntime;
}

function hasRuntime(command: string): boolean {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}
