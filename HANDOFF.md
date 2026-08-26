# Handoff

## Goal

Define a DSH-based personal Coding Agent plugin architecture that is ChatGPT/Codex-first, context-efficient, selectively multi-agent, and evidence-driven; establish a reusable Direnv + Home Manager DeepSeek Harness development environment for that work.

## Current Status

`README.md` records the full architecture baseline: lifecycle, component boundaries, data contracts, scheduling rules, prompt/cache behavior, code intelligence, memory, verification, telemetry, safety, a three-tier plugin reuse analysis, configuration, v0.1-v0.6 roadmap, and measurable hypotheses.

The repository now also provides a Nix Flake with a Node.js 24 development shell, a reusable `homeManagerModules.deepseek-harness-dev` module that only enables `direnv` and `nix-direnv`, and an `.envrc` containing only `use flake`. The shell makes `DSH_HOME` repository-local. `.gitignore` excludes direnv cache, repository-local `.dsh` state, and an independently cloned `upstream/deepseek-harness` source tree. Harness remains a source-run dependency, not a global npm or Nix installation; no plugin implementation has been added.

## Key Decisions

- Extend DSH through plugins; do not fork its agent loop.
- Treat model compatibility as higher priority than prompt-cache reuse.
- Let the Orchestrator request capabilities and let a scheduler select `provider + model + prompt profile + reasoning effort`.
- Delegate only when the expected benefit covers token and latency cost.
- Require evaluation before promoting prompt, routing, or policy changes.
- Keep the initial package structure coarse; split plugins only when independent release or versioning becomes necessary.

## Validation

- `rg -n 'DeepSeek Harness 开发环境|homeManagerModules\.deepseek-harness-dev|direnv allow|corepack enable|pnpm run typecheck|allowBuilds' README.md` found every setup milestone in the README.
- `git diff --check` reported no whitespace errors after the documentation update, and `git status --short` showed only the intended `README.md` and `HANDOFF.md` documentation edits for this task before committing.
- `nix flake check --no-build` evaluated the local default development shell and Home Manager activation check successfully.
- `nix develop --command sh -c 'set -eu; test "$(node --version | cut -d. -f1)" = "v24"; corepack --version; git --version; gcc --version >/dev/null; clang --version >/dev/null; python3 --version; cargo --version; rg --version >/dev/null; jq --version; test "$DSH_HOME" = "$(git rev-parse --show-toplevel)/.dsh"'` completed successfully: Node was v24, Corepack, Git, GCC, Clang, Python, Cargo, Ripgrep, and jq were available, and `DSH_HOME` was repository-local.
- `git diff --check HEAD` reported no whitespace errors across the complete working tree.
- Harness was not cloned, `direnv allow` and Home Manager activation were not run, and no pnpm dependencies were installed; therefore Harness install, typecheck, build, and web-server behavior remain intentionally unverified.

## Next Step

Apply the module in the user's own Home Manager configuration, run `direnv allow`, and clone Harness into `upstream/deepseek-harness`; then install its dependencies and run the documented typecheck, build, and web-server checks. After that, validate the shortlisted plugins and current DSH extension points, then turn the v0.1 milestone into an implementation plan.

## Plugin Research (2026-08-25)

### Direct reuse candidates

- `PerryLink/dsh-lsp-actions`: strongest direct fit for bounded LSP actions; use its official-seam-first behavior, write-intent path, result caps, and real LSP integration tests.
- `030611/dsh-telemetry-redactor`: optional outbound telemetry safety layer; it redacts export copies without changing canonical session logs.
- `030611/dsh-verification-receipt`: optional low-cost execution telemetry; its receipt is not proof that tests passed.
- `82c86b8z86-stack/dsh-engineering-workflow`: reusable workflow preset/skills for gated planning, TDD, subagent work, and fresh verification.
- `AdonisSheldon/dsh-openai-oauth`: conditional provider reuse only after resolving Windows support and credential storage requirements.

### Adapt or extract

- `00080000/dsh-project-memory`: reuse indexing, BM25, citations, and incremental hash refresh; adapt storage, concurrency, path portability, and ContextBlock integration.
- `LeslieWylie/dsh-task-relay`: reuse the smallest queue and handoff ideas; adapt to WorkerHandoff, DAG ownership, idempotency, and recovery requirements.
- `CypherNaught-0x/DSH-Subagent-Model-Router`: extract route aliases, maxDepth, toolFilter, outputSchema, and wait/join behavior; do not couple to its UI slots.
- `BruceLanLan/dsh-tier-router`: extract strong/cheap planning, failure escalation, fallback TTL, and deterministic high-impact guards.

### Design references only

- `shuind/dsh-codex-harness` and `OpenTritium/dsh-codex-shim`: model compatibility and Codex tool-contract references, not OAuth, Provider, or cache compiler implementations.
- `ZRui-C/dsh-minimal-first-turn`: experimental A/B reference for model-specific first-turn conditioning; current README limits it to root sessions and does not support Windows.
- `beijingwahw/dsh-proactive`: borrow shadow mode, evidence feedback, confidence decay, kill switch, canary, rollback, and budget arbitration; do not import its broad autonomous/economic subsystem.
- `vibeinging/dsh-trace`: borrow event-to-trace mapping only; its private distribution and raw transcript retention make it unsuitable as a default dependency.

### Research caveats

- The awesome list states that inclusion means installability and description alignment, not security review or quality ranking; every plugin executes third-party code with host-level permissions.
- The implementation matrix must be rechecked against the target DSH version, Windows behavior, license, package artifact, and current maintenance status before installation.
