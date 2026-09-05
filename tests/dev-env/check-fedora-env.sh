#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
checker="$repo_root/scripts/check-fedora-dev-env.sh"
fixture_dir="$(mktemp -d)"
trap 'rm -rf "$fixture_dir"' EXIT

make_tool() {
  local name="$1"
  local output="${2:-}"

  {
    printf '%s\n' '#!/usr/bin/env bash'
    printf "printf '%%s\\\\n' %q\n" "$output"
  } > "$fixture_dir/$name"
  chmod +x "$fixture_dir/$name"
}

for tool in corepack pnpm git gcc clang make cmake pkg-config python3 uv rustc cargo \
  typescript-language-server rg fd jq tree-sitter gdb strace gh; do
  make_tool "$tool" "$tool test version"
done
make_tool node 'v24.1.0'
make_tool pnpm '11.7.0'

success_output="$(PATH="$fixture_dir:/usr/bin:/bin" bash "$checker")"
grep -F 'Fedora development environment is ready.' <<<"$success_output"

make_tool node 'v23.9.0'
set +e
failure_output="$(PATH="$fixture_dir:/usr/bin:/bin" bash "$checker" 2>&1)"
failure_status=$?
set -e

test "$failure_status" -ne 0
grep -F 'Node.js v23.9.0 is unsupported' <<<"$failure_output"
grep -F 'Install Node.js 24 or Node.js 22.19+' <<<"$failure_output"

rm "$fixture_dir/pnpm"
set +e
failure_output="$(PATH="$fixture_dir:/usr/bin:/bin" bash "$checker" 2>&1)"
failure_status=$?
set -e

test "$failure_status" -ne 0
grep -F 'Missing command: pnpm' <<<"$failure_output"

printf '%s\n' 'check-fedora-dev-env tests passed'
