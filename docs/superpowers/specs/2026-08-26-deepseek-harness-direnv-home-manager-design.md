# DeepSeek Harness Direnv + Home Manager 开发环境设计

## 背景

DS-Plugins 将围绕 DeepSeek Harness 开发个人 Coding Agent 插件。Harness 仍处于快速迭代阶段，因此当前不将 Harness 或其 JavaScript 依赖打包成 Nix package，也不通过 Home Manager 全局安装 Node.js、pnpm 或项目编译工具。

本设计沿用既定安装方案：Nix 提供可复现的系统工具链，Corepack 根据 Harness 仓库的 `packageManager` 字段选择 pnpm，Harness 从源码运行，插件在本仓库中独立开发。

## 目标

- 使用 Home Manager 声明式启用 `direnv` 和 `nix-direnv`。
- 进入 DS-Plugins 仓库时自动加载项目专属的 Nix dev shell。
- 为 Harness 源码及插件开发提供 Node.js 24、原生模块编译工具和常用代码工具。
- 将 Harness 状态保存在仓库本地，避免污染用户的全局 DSH 配置。
- 不硬编码用户名、Home 目录或单一机器路径。
- 提供从空环境到启动 Harness Web UI 的可执行文档。

## 非目标

- 不自动克隆、安装或更新 DeepSeek Harness。
- 不通过 Nix 构建 Harness 的 `node_modules` 或发布包。
- 不创建全局 pnpm 安装，也不同时安装独立 Corepack 包。
- 不管理编辑器、Shell 或用户的完整 Home Manager 配置。
- 不在本阶段创建业务插件、profile 或 Cordis patch。

## 方案

环境分为两个职责明确的层次。

### Home Manager 层

仓库提供一个可导入的 Home Manager module，仅配置：

```nix
programs.direnv = {
  enable = true;
  nix-direnv.enable = true;
};
```

该 module 不设置 `home.username`、`home.homeDirectory` 或 `home.stateVersion`，由用户已有的 Home Manager 配置负责这些主机和用户相关属性。

### 项目 Flake 层

仓库根目录的 `flake.nix` 提供默认 dev shell，并导出 Home Manager module。dev shell 包含：

- Harness runtime：Node.js 24（包含 Corepack wrapper）和 Git。
- 原生 Node 模块工具链：GCC、Clang、GNU Make、CMake、pkg-config 和 Python。
- 常用语言工具：uv、Rust 和 Cargo。
- 代码与诊断工具：TypeScript language server、ripgrep、fd、jq、tree-sitter、gdb、strace 和 GitHub CLI。

TypeScript 编译器仍以 Harness workspace 锁定的依赖为准；Nix 提供的 TypeScript 工具仅用于编辑器/LSP 支持。

Flake 使用 `nixos-unstable`，并为 nixpkgs 支持的常见 Linux 系统生成 dev shell，避免把架构硬编码成 `x86_64-linux`。

### Direnv 层

根目录 `.envrc` 只包含 `use flake`。用户首次进入仓库后执行一次 `direnv allow`，之后目录切换会自动加载和卸载环境。

## 目录结构

```text
DS-Plugins/
├── .envrc
├── .gitignore
├── flake.nix
├── flake.lock
├── home-manager/
│   └── deepseek-harness-dev.nix
├── upstream/
│   └── deepseek-harness/
├── plugins/
├── profiles/
└── docs/
```

`upstream/deepseek-harness` 是用户按文档克隆的上游 checkout，不由 Flake 创建。`plugins` 和 `profiles` 是后续实现目标，本次无需提前创建空目录。

## 环境与状态

dev shell 将 `DSH_HOME` 设置为仓库根目录下的 `.dsh`。路径基于 Flake 所在仓库计算，不依赖调用 shell 时的当前子目录。

以下内容不纳入版本控制：

- `.direnv/`：direnv 生成的环境缓存和链接。
- `.dsh/`：Harness profile、session 和其他本地状态。
- `upstream/deepseek-harness/`：独立的上游 Git checkout。

不会修改或覆盖用户已存在的全局 `DSH_HOME` 数据。

## 使用流程

1. 在用户现有 Home Manager 配置中导入仓库导出的 module，并执行 `home-manager switch`。
2. 在 DS-Plugins 根目录执行 `direnv allow`。
3. 将官方 Harness 仓库克隆到 `upstream/deepseek-harness`。
4. 进入 Harness checkout，执行 `corepack enable` 和 `pnpm --version`。
5. 执行 `pnpm install`、`pnpm run typecheck` 和 `pnpm run build`。
6. 使用 `pnpm dsh web` 启动，并访问 `http://127.0.0.1:3080`。

仓库文档还会说明：pnpm 10+ 默认限制依赖构建脚本；GitHub 来源的 TypeScript 插件如依赖 `prepare`，需要在相应 profile 的 `pnpm-workspace.yaml` 中显式加入 `allowBuilds`。

## 错误处理

- 如果 `direnv` 未启用，README 引导用户先应用 Home Manager module。
- 如果 Flake 评估失败，优先使用 `nix flake check` 和 `nix develop --command` 定位配置问题。
- 如果 Corepack 不可用，不额外加入 `pkgs.corepack`；先确认所选 nixpkgs 中 `nodejs_24` wrapper 的实际组成。
- 如果原生 Node 模块缺少库，只将明确需要的依赖加入 dev shell，不预先引入大量动态库。
- 如果插件的 `prepare` 被 pnpm 阻止，使用精确的 `allowBuilds` 条目，不全局放开构建脚本。

## 验证

实现完成后执行覆盖本次风险的最小验证：

1. `nix flake check` 验证 Flake 能够评估。
2. 通过 `nix develop --command` 检查 Node、Corepack、Git、编译器、Python、Rust 和关键源码工具可执行。
3. 检查 `DSH_HOME` 指向仓库内 `.dsh`。
4. 使用 Nix module 评估验证 Home Manager module 的语法和导出路径。
5. 检查实际 diff，并更新 `HANDOFF.md` 记录已运行与未运行的验证。

不会声称 Harness 的 `pnpm install`、typecheck 或 build 已通过，除非上游源码已存在且实际执行了这些命令。

## 安全与可复现性

- Flake lock 文件固定 nixpkgs 和 Home Manager 输入版本。
- Harness 依赖版本由其上游 lockfile 和 `packageManager` 字段控制。
- `direnv allow` 保持显式信任边界；仓库不会替用户自动批准 `.envrc`。
- 不执行外部克隆、依赖下载或 Home Manager switch，除非用户另行授权或明确要求。
