#!/usr/bin/env bash
set -euo pipefail

build_command() {
  local cmd="o-agents --target \"$INPUT_TARGET\""

  cmd="$cmd --main $INPUT_MAIN"
  if [[ -n "${INPUT_WORKFLOW:-}" ]]; then
    cmd="$cmd $INPUT_WORKFLOW"
    if [[ -n "${INPUT_PARAMS:-}" ]]; then
      cmd="$cmd '$INPUT_PARAMS'"
    fi
  fi

  if [[ -n "${INPUT_COMPARE:-}" ]]; then
    cmd="$cmd --compare $INPUT_COMPARE"
  fi

  cmd="$cmd --concurrency ${INPUT_CONCURRENCY:-1}"
  if [[ -n "${INPUT_COMMAND_CONCURRENCY:-}" ]]; then
    cmd="$cmd --command-concurrency $INPUT_COMMAND_CONCURRENCY"
  fi

  cmd="$cmd --init \"${INPUT_INIT:-bunx --bun @antfu/ni@latest}\""

  echo "$cmd"
}

main() {
  local cmd
  cmd=$(build_command)

  echo "Executing: $cmd"

  set +e
  eval "$cmd"
  local exit_code=$?
  set -e

  echo "exit-code=$exit_code" >> "$GITHUB_OUTPUT"

  if [[ $exit_code -ne 0 ]]; then
    echo "::error::o-agents failed with exit code $exit_code"
    exit $exit_code
  fi
}

main "$@"
