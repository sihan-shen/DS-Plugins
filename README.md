# DS-Plugins

[简体中文](README.zh-CN.md)

> ChatGPT/Codex-first orchestration for DeepSeek Harness.

DS-Plugins is a personal coding-agent plugin stack for making agent work more deliberate: keep the working context small, delegate only when it helps, and require evidence before accepting a result. It extends DeepSeek Harness through plugins and orchestration instead of replacing the underlying agent loop.

## Why this exists

Most agent systems get expensive and opaque as they add more models, tools, and workers. This project explores a smaller control plane around four ideas:

- compile only the context a task actually needs;
- choose Direct, Single Worker, or parallel work from the task rather than by default;
- make handoffs and verification explicit;
- let evaluation inform future policy changes without silently changing the runtime.

## What works today

The current v0.6 line includes:

- Direct and Single Worker execution;
- structured Handoff, budgets, and targeted verification;
- governed offline evidence resolution and evaluation;
- replay support for governed candidates.

This is still an evolving research and implementation workspace, not a drop-in replacement for DeepSeek Harness. Provider smoke tests remain disabled by default, so the normal test path does not require paid credentials.

## Quick start

The repository uses Node.js `^22.19.0 || >=24` and pnpm `11.7.0`.

The runtime plugins under `packages/` are Git submodules. Clone them with:

```bash
git clone --recurse-submodules https://github.com/sihan-shen/DS-Plugins.git
cd DS-Plugins
```

For an existing checkout, initialize them with `git submodule update --init --recursive`.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

To run the upstream Harness UI against this repository’s local state:

```bash
export DSH_HOME="$PWD/.dsh"
```

Then follow the upstream Harness setup in the [full design document](docs/dsh-design.md).

## Project map

| Path | What to find there |
| --- | --- |
| [`packages/dsh-orchestrator`](packages/dsh-orchestrator/README.md) | orchestration behavior and usage notes |
| [`packages/dsh-telemetry`](packages/dsh-telemetry/README.md) | telemetry and bounded records |
| [`docs/dsh-design.md`](docs/dsh-design.md) | architecture, lifecycle, contracts, and roadmap |
| [`HANDOFF.md`](HANDOFF.md) | current continuation state and deferred work |

## Guardrails

DS-Plugins deliberately does not:

- fork or modify the DeepSeek Harness agent loop;
- implement its own ChatGPT OAuth or disguise subscriptions as ordinary APIs;
- make multi-agent execution, full-suite testing, or automatic policy changes the default;
- enable strategy changes without evaluation evidence and a rollback boundary.

## Development notes

<details>
<summary>Current host and local state</summary>

The current development host is Arch Linux with Node.js `v26.8.1`, npm `12.0.2`, and Git `2.55.0`. The repository’s package manager declaration remains pnpm `11.7.0`; if the local pnpm command reports `unable to open database file`, repair the local pnpm/store installation before installing dependencies.

The repository intentionally ignores local Harness state, context caches, upstream clones, worktrees, dependency directories, TypeScript build output, and private telemetry stores. See [`.gitignore`](.gitignore) for the authoritative patterns.

</details>
