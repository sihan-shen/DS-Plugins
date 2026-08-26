# DeepSeek Harness Direnv + Home Manager Development Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reproducible, repository-local DeepSeek Harness plugin development environment loaded by direnv, with Home Manager responsible only for enabling direnv and nix-direnv.

**Architecture:** A root Nix flake owns the project-specific Node.js 24 and native build toolchain, exports a small reusable Home Manager module, and evaluates that module through a dummy check configuration. A minimal `.envrc` loads the flake; repository-local Harness state and the independently cloned upstream checkout remain untracked.

**Tech Stack:** Nix flakes, nixpkgs unstable, Home Manager, direnv, nix-direnv, Node.js 24, Corepack/pnpm

**Spec:** `docs/superpowers/specs/2026-08-26-deepseek-harness-direnv-home-manager-design.md`

## Global Constraints

- Use `github:NixOS/nixpkgs/nixos-unstable` and Node.js 24.
- Add a dev-shell `pnpm` wrapper derivation that executes `${pkgs.nodejs_24}/bin/corepack pnpm "$@"`, and make it win PATH resolution; do not add `pkgs.corepack` or a global/fixed pnpm package.
- Home Manager must manage only direnv/nix-direnv for this feature; it must not set `home.username`, `home.homeDirectory`, or `home.stateVersion` in the exported module.
- Harness must remain a source checkout under `upstream/deepseek-harness`; do not package, clone, install, or update it automatically.
- Set `DSH_HOME` to the current repository's `.dsh` directory without hard-coding a username or home path.
- Do not automatically execute `direnv allow`, `home-manager switch`, `pnpm install`, or other trust/network-changing commands.
- Support `x86_64-linux` and `aarch64-linux`.

---

### Task 1: Project flake and reusable Home Manager module

**Files:**
- Create: `flake.nix`
- Create: `home-manager/deepseek-harness-dev.nix`
- Generated: `flake.lock`

**Interfaces:**
- Consumes: nixpkgs package attributes and Home Manager's `lib.homeManagerConfiguration`.
- Produces: `devShells.<system>.default`, `checks.<system>.home-manager-module`, and `homeManagerModules.deepseek-harness-dev`.

- [ ] **Step 1: Create the reusable Home Manager module**

Create `home-manager/deepseek-harness-dev.nix` with exactly:

```nix
{ ... }:
{
  programs.direnv = {
    enable = true;
    nix-direnv.enable = true;
  };
}
```

- [ ] **Step 2: Create the root flake**

Create `flake.nix`:

```nix
{
  description = "DeepSeek Harness plugin development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs@{ self, nixpkgs, home-manager, ... }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      module = import ./home-manager/deepseek-harness-dev.nix;
    in
    {
      homeManagerModules.deepseek-harness-dev = module;

      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          pnpmWrapper = pkgs.runCommand "dsh-pnpm-wrapper" { } ''
            mkdir -p "$out/bin"
            cat > "$out/bin/pnpm" <<'EOF'
            #!${pkgs.runtimeShell}
            exec ${pkgs.nodejs_24}/bin/corepack pnpm "$@"
            EOF
            chmod +x "$out/bin/pnpm"
          '';
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              pnpmWrapper
              nodejs_24
              git
              gcc
              clang
              gnumake
              cmake
              pkg-config
              python3
              uv
              rustc
              cargo
              typescript-language-server
              ripgrep
              fd
              jq
              tree-sitter
              gdb
              strace
              gh
            ];

            shellHook = ''
              export PATH="${pnpmWrapper}/bin:$PATH"

              project_root="$(pwd -P)"
              while
                ! test -f "$project_root/flake.nix" \
                  || ! test -f "$project_root/home-manager/deepseek-harness-dev.nix"
              do
                if test "$project_root" = "/"; then
                  echo "DeepSeek Harness development shell: could not find the DS-Plugins project root from $(pwd -P)" >&2
                  exit 1
                fi

                project_root="$(dirname -- "$project_root")"
              done

              export DSH_HOME="$project_root/.dsh"
              unset project_root

              echo "DeepSeek Harness development shell"
              echo "Node: $(node --version)"
              echo "Corepack: $(corepack --version 2>/dev/null || echo unavailable)"
              echo "DSH_HOME: $DSH_HOME"
            '';
          };
        });

      checks = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          testHome = home-manager.lib.homeManagerConfiguration {
            inherit pkgs;
            modules = [
              module
              {
                home.username = "dsh-test";
                home.homeDirectory = "/home/dsh-test";
                home.stateVersion = "24.11";
              }
            ];
          };
        in
        {
          home-manager-module = testHome.activationPackage;
        });
    };
}
```

- [ ] **Step 3: Format the Nix files**

Run:

```bash
nix fmt -- flake.nix home-manager/deepseek-harness-dev.nix
```

If the flake does not expose a formatter yet, use:

```bash
nix run nixpkgs#nixfmt-rfc-style -- flake.nix home-manager/deepseek-harness-dev.nix
```

Expected: both files are formatted without errors. Do not add a permanent formatter output solely to satisfy this step.

- [ ] **Step 4: Generate the lock file and evaluate the flake**

Run:

```bash
nix flake lock
nix flake check --all-systems --no-build
```

Expected: `flake.lock` is created; flake evaluation succeeds for both supported Linux systems and the Home Manager module check resolves to an activation derivation.

- [ ] **Step 5: Verify the current-system shell interface**

Run:

```bash
nix develop --command sh -c 'set -eu; node --version; corepack --version; git --version; pnpm_path=$(command -v pnpm); case "$pnpm_path" in /nix/store/*-dsh-pnpm-wrapper/bin/pnpm) ;; *) exit 1 ;; esac; minimal_path=$(dirname -- "$pnpm_path"):$(dirname -- "$(command -v node)"); env -i HOME="$HOME" PATH="$minimal_path" pnpm --version; test "$DSH_HOME" = "$(pwd -P)/.dsh"'
```

Expected: Node reports major version 24, Corepack and Git report versions, pnpm resolves to the dev-shell wrapper and prints its version from the minimal environment, and the root `DSH_HOME` assertion exits successfully. Also run the same `DSH_HOME` assertion from a temporary ignored nested Git checkout and confirm it still points to the DS-Plugins root.

- [ ] **Step 6: Commit the flake and module**

```bash
git add flake.nix flake.lock home-manager/deepseek-harness-dev.nix
git commit -m "build: add Harness Nix development shell"
```

### Task 2: Direnv trust boundary and local-state exclusions

**Files:**
- Create: `.envrc`
- Create: `.gitignore`

**Interfaces:**
- Consumes: `devShells.<current-system>.default` from Task 1.
- Produces: automatic `use flake` loading after explicit user approval, plus exclusions for `.direnv`, `.dsh`, and the upstream Harness checkout.

- [ ] **Step 1: Create the minimal direnv file**

Create `.envrc` with exactly:

```bash
use flake
```

- [ ] **Step 2: Create local-state exclusions**

Create `.gitignore` with exactly:

```gitignore
# direnv cache and links
/.direnv/

# Repository-local DeepSeek Harness state
/.dsh/

# Independently cloned upstream source
/upstream/deepseek-harness/
```

- [ ] **Step 3: Verify the files without approving direnv**

Run:

```bash
test "$(sed -n '1p' .envrc)" = "use flake"
git check-ignore -q .direnv/example
git check-ignore -q .dsh/example
git check-ignore -q upstream/deepseek-harness/package.json
```

Expected: all commands exit with status 0. Do not run `direnv allow`; approval remains a user action.

- [ ] **Step 4: Check whitespace and commit**

Run:

```bash
git diff --check
git add .envrc .gitignore
git commit -m "build: load Harness shell with direnv"
```

Expected: no whitespace errors and a commit containing only `.envrc` and `.gitignore`.

### Task 3: User-facing setup and validation documentation

**Files:**
- Modify: `README.md`
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: the flake output names, paths, commands, and trust boundary established in Tasks 1-2.
- Produces: a copy-pasteable installation path and an evidence-backed project handoff.

- [ ] **Step 1: Add a development-environment section to README**

Insert a new top-level section immediately after the introductory block and before `## 目录`:

````markdown
## DeepSeek Harness 开发环境

本仓库采用两层环境：Home Manager 只启用 `direnv + nix-direnv`，项目 Flake 固定 Node.js 24、Corepack、项目专属 pnpm wrapper 和编译工具。Harness 本身从源码运行，不作为全局 npm 或 Nix package 安装。

### 1. 启用 Home Manager module

在现有 Home Manager flake 中加入本仓库输入：

```nix
inputs.ds-plugins.url = "git+file:///你的/DS-Plugins/绝对路径";
```

把输入传入 Home Manager 配置后导入 module：

```nix
imports = [
  inputs.ds-plugins.homeManagerModules.deepseek-harness-dev
];
```

应用现有 Home Manager 配置：

```bash
home-manager switch --flake /你的/home-manager/flake路径#你的配置名
```

本 module 不设置用户名、Home 目录或 `home.stateVersion`。

### 2. 允许项目环境

```bash
cd /你的/DS-Plugins/绝对路径
direnv allow
```

`.envrc` 只有 `use flake`。授权后，每次进入仓库都会自动加载项目工具链，并将 `DSH_HOME` 设置为仓库内的 `.dsh`。

检查环境：

```bash
node --version
corepack --version
command -v pnpm
pnpm --version
git --version
printf '%s\n' "$DSH_HOME"
```

Node 应为 24.x，`pnpm` 应解析到 Nix dev shell 的 `dsh-pnpm-wrapper`，`DSH_HOME` 应指向本仓库的 `.dsh`。该 wrapper 直接执行 Node.js 24 自带的 `corepack pnpm`，无需也不应启用 Corepack shim；shim 启用会尝试写入不可变的 Nix store。

### 3. 安装并运行 Harness 源码

```bash
mkdir -p upstream
git clone https://github.com/deepseek-ai/deepseek-harness.git upstream/deepseek-harness
cd upstream/deepseek-harness
pnpm --version
pnpm install
pnpm run typecheck
pnpm run build
pnpm dsh web
```

浏览器访问 `http://127.0.0.1:3080`。dev shell 的 pnpm wrapper 会让 Corepack 依据 Harness 的 `package.json#packageManager` 选择 pnpm；不要另行全局安装 pnpm。

如果 GitHub 来源的 TypeScript 插件依赖 `prepare` 构建，而 pnpm 10+ 报告脚本被忽略，请只在对应 profile 的 `pnpm-workspace.yaml` 中允许该包：

```yaml
allowBuilds:
  dsh-your-plugin: true
```

不要全局放开依赖构建脚本。
````

Also add `DeepSeek Harness 开发环境` as the first item in the existing table of contents, linked to `#deepseek-harness-开发环境`.

- [ ] **Step 2: Update HANDOFF with the completed environment state**

Replace the current `## Goal`, `## Current Status`, `## Validation`, and `## Next Step` sections so they also state:

- Goal includes establishing the Direnv + Home Manager Harness development environment.
- Current status lists the new flake, reusable Home Manager module, `.envrc`, and local state exclusions.
- Validation lists each command actually run and its observed result; it must not claim Harness install/typecheck/build unless the upstream source was present and those commands were run.
- Next step begins with applying the module in the user's own Home Manager configuration, running `direnv allow`, and cloning Harness.

Preserve the architecture decisions and plugin research sections that remain current. Do not paste chat transcripts or duplicate details visible directly in the diff.

- [ ] **Step 3: Verify documentation and the full configuration diff**

Run:

```bash
rg -n 'DeepSeek Harness 开发环境|homeManagerModules\.deepseek-harness-dev|direnv allow|dsh-pnpm-wrapper|pnpm run typecheck|allowBuilds' README.md
git diff --check
git status --short
```

Expected: every setup milestone is found, no whitespace errors exist, and only the intended documentation/HANDOFF edits are pending for this task.

- [ ] **Step 4: Run final targeted verification**

Run:

```bash
nix flake check --all-systems --no-build
nix develop --command sh -c 'set -eu; test "$(node --version | cut -d. -f1)" = "v24"; corepack --version; git --version; gcc --version >/dev/null; clang --version >/dev/null; python3 --version; cargo --version; rg --version >/dev/null; jq --version; pnpm_path=$(command -v pnpm); case "$pnpm_path" in /nix/store/*-dsh-pnpm-wrapper/bin/pnpm) ;; *) exit 1 ;; esac; minimal_path=$(dirname -- "$pnpm_path"):$(dirname -- "$(command -v node)"); env -i HOME="$HOME" PATH="$minimal_path" pnpm --version; test "$DSH_HOME" = "$(pwd -P)/.dsh"'
git diff --check HEAD
```

Expected: Both supported systems and the Home Manager module evaluate; every listed tool is executable; Node is v24; pnpm resolves to the shell wrapper and runs in the minimal environment; root and nested-checkout `DSH_HOME` remain repository-local; the complete working tree has no whitespace errors.

- [ ] **Step 5: Commit documentation and handoff**

```bash
git add README.md HANDOFF.md
git commit -m "docs: explain Harness environment setup"
```

## Completion Review

- [ ] Inspect `git status --short --branch` and `git log --oneline --decorate -5`.
- [ ] Confirm the three implementation commits contain only their intended paths.
- [ ] Confirm no command has cloned Harness, approved `.envrc`, switched Home Manager, or installed pnpm dependencies.
- [ ] Report the exact validation commands and outcomes, plus the intentionally unverified Harness install/typecheck/build steps.
