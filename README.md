# o-agents

CLI tool that orchestrates Codex CLI, Claude Code, or Gemini CLI to implement GitHub issues or PRs end-to-end.
It fetches the issue/PR via `gh`, creates a branch, runs the selected agent workflow, commits the changes, and opens a PR.

## Requirements

- Bun
- `gh` authenticated to the target repo
- One of:
  - `@openai/codex`
  - `@anthropic-ai/claude-code`
  - ~~`@google/gemini-cli`~~ (Unusable due to https://github.com/google-gemini/gemini-cli/issues/16567)

## Installation

```sh
bun add -g o-agents
```

If you prefer not to install globally, run from the repo with `bun run start`.

## Usage

```sh
o-agents --target 123 --main codex
o-agents --target 123 --main claude-code o-agents/workflowWithTests.ts
o-agents --target 456 --main gemini-cli o-agents/workflowWithTests.ts
o-agents --target 123 --main codex-cli o-agents/workflowWithTests.ts '{"testCommand":["bun","test"]}'
o-agents --target 123 --main codex-cli o-agents/workflowWithTests.ts ./params.json
o-agents --target 123 --main codex-cli o-agents/workflowWithTests.ts --compare claude-code o-agents/workflowWithTests.ts
o-agents --target 123 --main codex --concurrency 2 --compare claude
o-agents --target 123 --main codex --command-concurrency 1 --compare claude
o-agents --target 123 --main codex --init "bunx --bun @antfu/ni@latest"
o-agents --target https://github.com/org/repo/issues/123 --main codex
```

Workflows run sequentially by default (`--concurrency 1`).
Use `--concurrency` to control how many workflows can run at the same time (main/compare).
Use `--command-concurrency` to cap how many external commands started by workflows (like tests/builds) can run at once.
If you omit `--command-concurrency`, there is no extra limit beyond how many workflows are running.
Comparison happens only when at least two PR URLs are created.
Initialization runs once per worktree using `--init` (default: `bunx --bun @antfu/ni@latest`).

You can use agent aliases (`codex`, `claude`, `gemini`) instead of full tool names.
If `--main` omits workflow/params entirely, it defaults to `o-agents/workflowNoTest.ts`.
Shorthand `--compare <agent>` inherits the workflow/params from `--main`.
If `--main` omits params, the workflow uses its defaults. Params can be a JSON string or a path to a JSON file.

Logs are written under `.o-agents-logs/app`.

## Contributing

Issues and PRs are welcome. Please run `bun run test` and `bun run typecheck` before submitting.

## License

Apache-2.0
