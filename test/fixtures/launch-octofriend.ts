import { spawnSync } from "node:child_process";
import { resolveNpxCommand } from "../../src/utils/runtime.ts";

const { command, args } = resolveNpxCommand();
const baseArgs = [...args, "--yes", "octofriend@latest", "version"];
const primary = spawnSync(command, baseArgs, { stdio: "inherit" });
if (primary.status === 0) {
  process.exit(0);
}
process.exit(primary.status ?? 1);
