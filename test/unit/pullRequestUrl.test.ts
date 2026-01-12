import { expect, test } from "bun:test";

import { extractPullRequestUrl } from "../../src/git/git.ts";

test("extractPullRequestUrl prefers GitHub PR links in stdout", () => {
  const stdout = [
    "Creating pull request for feature branch.",
    "More info at https://example.com/docs/123",
    "https://github.com/octo-org/octo-repo/pull/42",
  ].join("\n");

  const url = extractPullRequestUrl(stdout, "");

  expect(url).toBe("https://github.com/octo-org/octo-repo/pull/42");
});

test("extractPullRequestUrl falls back to stderr", () => {
  const stderr = "https://github.com/octo-org/octo-repo/pull/99";

  const url = extractPullRequestUrl("", stderr);

  expect(url).toBe("https://github.com/octo-org/octo-repo/pull/99");
});

test("extractPullRequestUrl returns undefined when no URL is present", () => {
  const url = extractPullRequestUrl("No link here.", "Still nothing.");

  expect(url).toBeUndefined();
});
