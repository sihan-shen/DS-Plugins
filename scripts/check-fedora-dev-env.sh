#!/usr/bin/env bash
set -euo pipefail

required_commands=(
  node pnpm git gcc clang make cmake pkg-config python3 uv rustc cargo
  typescript-language-server rg fd jq tree-sitter gdb strace gh
)
status=0

for command_name in "${required_commands[@]}"; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Missing command: %s\n' "$command_name" >&2
    status=1
  fi
done

if command -v node >/dev/null 2>&1; then
  node_version="$(node --version)"
  node_semver="${node_version#v}"
  node_major="${node_semver%%.*}"
  node_rest="${node_semver#*.}"
  node_minor="${node_rest%%.*}"

  if ! { test "$node_major" -eq 22 && test "$node_minor" -ge 19; } \
    && ! test "$node_major" -ge 24; then
    printf 'Node.js %s is unsupported. Install Node.js 24 or Node.js 22.19+.\n' \
      "$node_version" >&2
    status=1
  fi
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm_version="$(pnpm --version)"
  if test "$pnpm_version" != '11.7.0'; then
    printf 'pnpm %s is unsupported. Install pnpm 11.7.0.\n' "$pnpm_version" >&2
    status=1
  fi
fi

if test "$status" -ne 0; then
  printf '%s\n' 'See README.md#fedora-development-environment for installation steps.' >&2
  exit "$status"
fi

printf '%s\n' 'Fedora development environment is ready.'
printf 'Node.js: %s\n' "$(node --version)"
printf 'pnpm: %s\n' "$(pnpm --version)"
printf 'Git: %s\n' "$(git --version)"
