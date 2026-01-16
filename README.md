# o-agents

CLI tool that orchestrates Codex CLI, Claude Code, or Gemini CLI to implement GitHub issues or PRs end-to-end.
It fetches the issue/PR via `gh`, creates a branch, runs the selected agent workflow, commits the changes, and opens a PR.

## Requirements

- [Bun](https://bun.com/)
  - `o-agents` itself runs only with Bun.
- [Node.js](https://nodejs.org/)
  - `o-agents` launches agents via `npx` because `@google/gemini-cli` and `octofriend` cannot work with `npx --yes` reliably.
- Supported OS: WSL (Linux), macOS, Linux. Windows is not supported.
- `gh` authenticated to the target repo
- One of (short names are o-agents aliases):
  - `@openai/codex` (`codex`)
  - `@anthropic-ai/claude-code` (`claude`)
  - `@google/gemini-cli` (`gemini`) (Unstable due to https://github.com/google-gemini/gemini-cli/issues/16567)
  - `octofriend` (`octo`) (Unstable)

## Installation

```sh
bun add -g o-agents
```

This package is published to npm as source-only TypeScript and requires Bun at runtime (it uses `Bun.*` APIs like `Bun.Terminal`).
If you prefer not to install globally, run from the repo with `bun run start`.

## Usage

```sh
o-agents simple --target 123
o-agents --target 123 --main codex
o-agents --target 123 --main claude o-agents/workflowWithTests.ts
o-agents --target 456 --main gemini o-agents/workflowWithTests.ts
o-agents --target 123 --main codex o-agents/workflowWithTests.ts '{"testCommand":["bun","test"]}'
o-agents --target 123 --main codex o-agents/workflowWithTests.ts ./params.json
o-agents --target 123 --main codex o-agents/workflowWithTests.ts --compare claude o-agents/workflowWithTests.ts
o-agents --target 123 --main codex --concurrency 2 --compare claude
o-agents --target 123 --main codex --command-concurrency 1 --compare claude
o-agents --target 123 --main codex --init "npx @antfu/ni@latest"
o-agents --target https://github.com/org/repo/issues/123 --main codex
```

You can also save argument presets in a TOML file and invoke them with `o-agents <name>`.
`o-agents` reads `o-agents/config.toml` from the current directory.

```toml
[config.simple]
args = ["--main", "codex", "o-agents/workflowSimple.ts"]
```

Workflows run sequentially by default (`--concurrency 1`).
Use `--concurrency` to control how many workflows can run at the same time (main/compare).
Use `--command-concurrency` to cap how many external commands started by workflows (like tests/builds) can run at once.
If you omit `--command-concurrency`, there is no extra limit beyond how many workflows are running.
Comparison happens only when at least two PR URLs are created.
Initialization runs once per worktree using `--init` (default: `npx @antfu/ni@latest`).

Use the short agent names: `codex`, `claude`, `gemini`, `octo`.
If `--main` omits workflow/params entirely, it defaults to `o-agents/workflowNoTest.ts`.
Shorthand `--compare <agent>` inherits the workflow/params from `--main`.
If `--main` omits params, the workflow uses its defaults. Params can be a JSON string or a path to a JSON file.

Logs are written under `.o-agents-logs/`:

- `.o-agents-logs/app/<runTimestamp>/run-<issue|pr>-<id>.log`
- `.o-agents-logs/app/<runTimestamp>/workflow-<runLabel>-<kind>-<index>.log`
- `.o-agents-logs/response/<timestamp>.log`
- `.o-agents-logs/test/<timestamp>/`

## Contributing

Issues and PRs are welcome. Please run `bun run test` and `bun run typecheck` before submitting.

## License

Apache-2.0
