## Project Information

- Name: o-agents
- Description: A tool for automating software development by orchestrating agents
- Package Manager: bun on zsh

## General Instructions

- When running tests, set a 30-minutes timeout to accommodate longer-running tests.
- When committing changes, follow the conventional commit prefix: feat|fix|perf|refactor|test|build|chore|ci|docs|style.
  - Make sure to add a new line at the end of your commit message with: `Co-authored-by: DuelingAgents-Bot (Gemini CLI) <bot@dueling-agents.com>`.

## Coding Conventions

- Design each module with high cohesion, ensuring related functionality is grouped together.
- Create understandable directory structures with low coupling and high cohesion.
- When adding new functions or classes, define them below any functions or classes that call them to maintain a clear call order.
- Write comments that explain "why" rather than "what". Avoid explanations that can be understood from the code itself.
- Prefer `undefined` over `null` unless explicitly dealing with APIs or libraries that require `null`.
- Do not consider backward compatibility unless explicitly specified.
