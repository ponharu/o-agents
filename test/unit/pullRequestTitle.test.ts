import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";

import { getFirstCommitTitle } from "../../src/git/git.ts";

test("getFirstCommitTitle returns the oldest commit title in the range", async () => {
  const repoDir = mkdtempSync(join(tmpdir(), "o-agents-pr-title-"));

  try {
    runGit(repoDir, ["init", "-b", "main"]);
    runGit(repoDir, ["config", "user.email", "test@example.com"]);
    runGit(repoDir, ["config", "user.name", "Test User"]);

    writeFileSync(join(repoDir, "README.md"), "base", "utf8");
    runGit(repoDir, ["add", "."]);
    runGit(repoDir, ["commit", "-m", "base commit"]);

    runGit(repoDir, ["checkout", "-b", "feature"]);
    writeFileSync(join(repoDir, "feature.txt"), "first", "utf8");
    runGit(repoDir, ["add", "."]);
    runGit(repoDir, ["commit", "-m", "first change"]);

    writeFileSync(join(repoDir, "feature.txt"), "second", "utf8");
    runGit(repoDir, ["add", "."]);
    runGit(repoDir, ["commit", "-m", "second change"]);

    const title = await getFirstCommitTitle(repoDir, "main", "feature");

    expect(title).toBe("first change");
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
