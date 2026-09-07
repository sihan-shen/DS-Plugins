# DS-Plugins

[English](README.md)

> 面向 DeepSeek Harness 的 ChatGPT/Codex-first 编排层。

DS-Plugins 是一套个人 Coding Agent 插件，用来让 Agent 工作更有边界：保持工作上下文足够小，只在确实有收益时委派任务，并要求用证据确认结果。项目通过插件和编排层扩展 DeepSeek Harness，而不是替换底层的 Agent loop。

## 为什么做这个项目

随着模型、工具和 Worker 不断增加，Agent 系统很容易变得昂贵且难以解释。这个项目围绕四个方向探索一个更小的控制面：

- 只编译任务真正需要的上下文；
- 根据任务选择 Direct、Single Worker 或并行执行，而不是默认多 Agent；
- 明确记录 Handoff 和验证过程；
- 让评估结果推动后续策略改进，但不静默修改运行时。

## 当前能做什么

当前 v0.6 版本包括：

- Direct 和 Single Worker 执行；
- 结构化 Handoff、预算控制和 targeted verification；
- 受治理的离线证据解析与评估；
- 受治理候选项的 replay 支持。

这是一个仍在演进中的研究与实现工作区，不是 DeepSeek Harness 的即插即用替代品。Provider smoke test 默认关闭，因此常规测试路径不需要付费凭据。

## 快速开始

仓库要求 Node.js `^22.19.0 || >=24` 和 pnpm `11.7.0`。

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

如果要让 upstream Harness UI 使用本仓库的本地状态：

```bash
export DSH_HOME="$PWD/.dsh"
```

然后按照[完整设计文档](docs/dsh-design.md)中的 upstream Harness 设置步骤继续操作。

## 项目导航

| 路径 | 内容 |
| --- | --- |
| [`packages/dsh-orchestrator`](packages/dsh-orchestrator/README.md) | 编排行为和使用说明 |
| [`packages/dsh-telemetry`](packages/dsh-telemetry/README.md) | telemetry 与有界记录 |
| [`docs/dsh-design.md`](docs/dsh-design.md) | 架构、生命周期、数据契约和路线图 |
| [`HANDOFF.md`](HANDOFF.md) | 当前延续状态和延期工作 |

## 边界与护栏

DS-Plugins 有意不做以下事情：

- fork 或修改 DeepSeek Harness 的 Agent loop；
- 自行实现 ChatGPT OAuth，或把订阅伪装成普通 API；
- 默认启用多 Agent、全量测试或自动策略修改；
- 在没有评估证据和回滚边界的情况下启用策略变化。

## 开发说明

<details>
<summary>当前主机与本地状态</summary>

当前开发主机是 Arch Linux，Node.js 为 `v26.8.1`，npm 为 `12.0.2`，Git 为 `2.55.0`。仓库声明的包管理器仍是 pnpm `11.7.0`；如果本地 pnpm 报告 `unable to open database file`，请先修复本机 pnpm/store 安装状态，再安装项目依赖。

仓库会忽略本地 Harness 状态、上下文缓存、upstream clone、worktree、依赖目录、TypeScript 构建产物和私有 telemetry store。权威规则请参见 [`.gitignore`](.gitignore)。

</details>
