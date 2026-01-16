# o-agents

CLI tool that orchestrates Codex CLI, Claude Code, or Gemini CLI to implement GitHub issues or PRs end-to-end.
It fetches the issue/PR via `gh`, creates a branch, runs the selected agent workflow, commits the changes, and opens a PR.

## Requirements

- [Bun](https://bun.com/) — `o-agents` itself runs only with Bun
- [Node.js](https://nodejs.org/) — agents are launched via `npx`
- Supported OS: WSL (Linux), macOS, Linux (Windows is not supported)
- `gh` authenticated to the target repo
- One of the supported agents:

| Agent                       | Alias      | Status                                                                       |
| --------------------------- | ---------- | ---------------------------------------------------------------------------- |
| `@openai/codex`             | `codex`    | Stable                                                                       |
| `@anthropic-ai/claude-code` | `claude`   | Stable                                                                       |
| `@google/gemini-cli`        | `gemini`   | Unstable ([issue](https://github.com/google-gemini/gemini-cli/issues/16567)) |
| `octofriend`                | `octo`     | Unstable                                                                     |
| `opencode-ai`               | `opencode` | Stable                                                                       |

## Installation

```sh
bun add -g o-agents
```

This package is published to npm as source-only TypeScript and requires Bun at runtime (it uses `Bun.*` APIs like `Bun.Terminal`).
If you prefer not to install globally, run from the repo with `bun run start`.

## Usage

### Basic Examples

```sh
# Use a config preset
o-agents simple --target 123

# Specify agent directly
o-agents --target 123 --main codex
o-agents --target 123 --main claude o-agents/workflowWithTests.ts

# Pass workflow parameters (JSON string or file path)
o-agents --target 123 --main codex o-agents/workflowWithTests.ts '{"testCommand":["bun","test"]}'
o-agents --target 123 --main codex o-agents/workflowWithTests.ts ./params.json

# Compare multiple agents
o-agents --target 123 --main codex --compare claude
o-agents --target 123 --main codex o-agents/workflowWithTests.ts --compare claude o-agents/workflowWithTests.ts

# Use GitHub URL as target
o-agents --target https://github.com/org/repo/issues/123 --main codex
```

### Options

| Option                  | Description                                                                      | Default                      |
| ----------------------- | -------------------------------------------------------------------------------- | ---------------------------- |
| `--target`              | Issue/PR number or GitHub URL                                                    | (required)                   |
| `--main`                | Main agent and optional workflow/params                                          | `o-agents/workflowNoTest.ts` |
| `--compare`             | Additional agents to compare (inherits workflow/params from `--main` if omitted) | —                            |
| `--concurrency`         | Max concurrent workflows (main/compare)                                          | `1`                          |
| `--command-concurrency` | Max concurrent external commands (tests/builds)                                  | unlimited                    |
| `--init`                | Initialization command run once per worktree                                     | `npx --yes @antfu/ni@latest` |

## Configuration

`o-agents` reads configuration from `o-agents/config.toml` in the current directory.

### Presets

Save argument presets to invoke with `o-agents <name>`:

```toml
[config.simple]
args = ["--main", "codex", "o-agents/workflowSimple.ts"]

[config.test]
args = ["--main", "claude", "o-agents/workflowWithTests.ts"]
```

### Custom Agents

Define new agents or override built-in agents:

```toml
[agents.my-custom-agent]
cmd = ["my-agent", "--flag"]
aliases = ["my"]
terminal = true

# Override built-in claude-code with simpler flags
[agents.claude-code]
cmd = ["npx", "--yes", "@anthropic-ai/claude-code@latest", "--print"]
```

The prompt is appended as the final argument to `cmd` automatically.

### Default Agent Configurations

For reference, here are the built-in agent configurations:

<details>
<summary>Click to expand</summary>

```toml
[agents.codex-cli]
cmd = ["npx", "--yes", "@openai/codex@latest", "exec", "--dangerously-bypass-approvals-and-sandbox"]
aliases = ["codex"]
versionCmd = ["npx", "--yes", "@openai/codex@latest", "--version"]

[agents.claude-code]
cmd = ["npx", "--yes", "@anthropic-ai/claude-code@latest", "--dangerously-skip-permissions", "--allowed-tools", "Bash,Edit,Write", "--print"]
aliases = ["claude"]
versionCmd = ["npx", "--yes", "@anthropic-ai/claude-code@latest", "--version"]

[agents.gemini-cli]
cmd = ["npx", "--yes", "@google/gemini-cli@latest", "--approval-mode", "yolo", "--prompt-interactive"]
aliases = ["gemini"]
terminal = true
versionCmd = ["npx", "--yes", "@google/gemini-cli@latest", "--version"]

[agents.octofriend]
cmd = ["npx", "--yes", "octofriend@latest", "prompt"]
aliases = ["octo"]
versionCmd = ["npx", "--yes", "octofriend@latest", "version"]

[agents.opencode-ai]
cmd = ["npx", "--yes", "opencode-ai@latest", "run"]
aliases = ["opencode"]
versionCmd = ["npx", "--yes", "opencode-ai@latest", "--version"]
```

</details>

## Logs

Logs are written under `.o-agents-logs/`:

| Path                                                                       | Description           |
| -------------------------------------------------------------------------- | --------------------- |
| `.o-agents-logs/app/<runTimestamp>/run-<issue\|pr>-<id>.log`               | Main run log          |
| `.o-agents-logs/app/<runTimestamp>/workflow-<runLabel>-<kind>-<index>.log` | Workflow log          |
| `.o-agents-logs/response/<timestamp>.log`                                  | Agent response log    |
| `.o-agents-logs/test/<timestamp>/`                                         | Test output directory |

## Contributing

Issues and PRs are welcome. Please run `bun run test` and `bun run typecheck` before submitting.

## License

Apache-2.0
