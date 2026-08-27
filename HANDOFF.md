# Handoff

## Goal

Define a DSH-based personal Coding Agent plugin architecture that is ChatGPT/Codex-first, context-efficient, selectively multi-agent, and evidence-driven; establish a reusable Direnv + Home Manager DeepSeek Harness development environment for that work.

## Current Status

`README.md` records the full architecture baseline: lifecycle, component boundaries, data contracts, scheduling rules, prompt/cache behavior, code intelligence, memory, verification, telemetry, safety, a three-tier plugin reuse analysis, configuration, v0.1-v0.6 roadmap, and measurable hypotheses.

The repository now also provides a Nix Flake with a Node.js 24 development shell, a reusable `homeManagerModules.deepseek-harness-dev` module that only enables `direnv` and `nix-direnv`, and an `.envrc` containing only `use flake`. The shell supplies a `dsh-pnpm-wrapper` that invokes Node.js 24's `corepack pnpm`, takes PATH precedence over unrelated pnpm binaries, and preserves the upstream `packageManager` selection without writing shims into the Nix store. It also supplies `dsh-web`, which locates the repository-local Harness checkout and applies the required Nix Node compatibility launch automatically. The shell resolves `DSH_HOME` by walking upward for the DS-Plugins marker pair, so an independently cloned nested Harness Git checkout still uses the repository-local `.dsh`. `.gitignore` excludes direnv cache, that local state, and the upstream checkout. Harness remains a source-run dependency, not a global npm or Nix installation; no runnable plugin implementation has been added.

The official Harness checkout now exists at `upstream/deepseek-harness` on commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (`0.1.1-rc.2`). Its pnpm dependencies are installed, typecheck and production build pass, and the Web UI is running at `http://127.0.0.1:3080`. On the current Nix-built Node.js 24.19, `node-addon-require-builtin@0.1.4` cannot discover Node's internal ESM loader, so source launch uses the upstream-supported direct Node fallback: `node --expose-internals --import tsx/esm apps/cli/src/bin.ts web --no-open`.

## Key Decisions

- Extend DSH through plugins; do not fork its agent loop.
- Treat model compatibility as higher priority than prompt-cache reuse.
- Let the Orchestrator request capabilities and let a scheduler select `provider + model + prompt profile + reasoning effort`.
- Delegate only when the expected benefit covers token and latency cost.
- Require evaluation before promoting prompt, routing, or policy changes.
- Keep the initial package structure coarse; split plugins only when independent release or versioning becomes necessary.

## Validation

- `nix run nixpkgs#nixfmt-rfc-style -- flake.nix home-manager/deepseek-harness-dev.nix` completed successfully, and `git diff --check -- flake.nix home-manager/deepseek-harness-dev.nix` reported no whitespace errors.
- Exact all-system evidence: `nix flake check --all-systems --no-build` exited 0 after evaluating `devShells.x86_64-linux.default`, `devShells.aarch64-linux.default`, `checks.x86_64-linux.home-manager-module`, and `checks.aarch64-linux.home-manager-module`; its final line was `all checks passed!`. The command emitted only the expected dirty-tree notice and the existing `unknown flake output 'homeManagerModules'` warning.
- The root `nix develop --command sh -c '...'` toolchain check exited 0 with Node `v24.19.0`, Corepack `0.35.0`, Git `2.55.0`, GCC `15.3.0`, Clang `21.1.8`, Python `3.14.7`, Cargo `1.97.0`, Ripgrep `15.2.0`, and jq `1.8.2`. `command -v pnpm` resolved to `/nix/store/idb0d90qg32509b1a652i5apz2gibikg-dsh-pnpm-wrapper/bin/pnpm`; `env -i HOME="$HOME" PATH="<wrapper-bin>:<node-bin>" pnpm --version` returned `11.24.0`; and `DSH_HOME` was `/home/sihan/Projects/DS-Plugins/.dsh`.
- From a temporary, ignored Git repository at `upstream/deepseek-harness`, `git rev-parse --show-toplevel` returned the nested checkout while `nix develop /home/sihan/Projects/DS-Plugins --command sh -c 'test "$DSH_HOME" = "/home/sihan/Projects/DS-Plugins/.dsh"'` still exited 0. The temporary checkout was removed afterward.
- From `/tmp`, `nix develop /home/sihan/Projects/DS-Plugins --command true` exited 1 with `DeepSeek Harness development shell: could not find the DS-Plugins project root from /tmp`, verifying clear failure when the marker pair is absent.
- The README milestone scan found the module import, `direnv allow`, `dsh-pnpm-wrapper`, pnpm checks, typecheck, and `allowBuilds`; a tracked-files scan found no obsolete Corepack shim-enablement workflow; `git diff --check HEAD` reported no whitespace errors.
- Home Manager activation and `direnv allow` were completed outside the repository and verified through a fresh interactive zsh session; nix-direnv reused its cached dev shell and exported the expected Node, pnpm wrapper, and `DSH_HOME` values.
- `git clone https://github.com/deepseek-ai/deepseek-harness.git upstream/deepseek-harness` completed at commit `b150a551`; upstream declares `packageManager=pnpm@11.7.0`, and the dev-shell wrapper selected pnpm `11.7.0`.
- `pnpm install` completed for all 246 workspace projects after supply-chain policy validation of 1,215 lockfile entries. Network retries recovered automatically; install finished with non-fatal pre-build example-bin warnings.
- `pnpm run typecheck` exited 0 after the Host library build and Client TypeScript project-reference check.
- The first sandboxed `pnpm run build` attempt failed because `tsx` could not create `/tmp/tsx-1000/112.pipe`; rerunning with local IPC permission exited 0, built Host and Client libraries, produced 200 client artifacts, and completed the Vite production build.
- Plain `pnpm dsh web --no-open` exposed an upstream/Nix compatibility issue: `node-addon-require-builtin@0.1.4` reports `Unsupported/no-getter` on Nix Node `24.19.0`, leaving Loader bare-package resolution unavailable. Direct launch with `node --expose-internals --import tsx/esm apps/cli/src/bin.ts web --no-open` uses Harness's internal-loader fallback and started successfully at `http://127.0.0.1:3080`.
- A same-permission-boundary `curl --fail http://127.0.0.1:3080/` returned `HTTP/1.1 200 OK` and a 14,555-byte Harness bootstrap page. No DeepSeek API credential or real provider call has been configured or tested.
- After adding `dsh-web`, `nix flake check --all-systems --no-build` again exited 0. A real `nix develop` resolved the command to the `dsh-web-wrapper` store path, its missing-checkout case returned the expected explicit error, and `dsh-web --help` exited 0 with the Harness Web CLI options. Provider and UI conversation validation was intentionally skipped.

## Next Step

Review and approve `docs/superpowers/specs/2026-08-27-dsh-v0.1-foundation-design.md`, then turn it into a task-level implementation plan. Track an upstream fix for `node-addon-require-builtin` on Nix Node so the local `dsh-web` compatibility wrapper can eventually return to the standard launch path.

## v0.1 Design Status (2026-08-27)

The shortlisted plugins and the DSH `0.1.1-rc.2` extension points were validated through three independent read-only reviews. The resulting design uses the official `dsh-llm-pi-ai` `openai-codex` OAuth path, a single out-of-tree orchestrator plugin, `ctx.subagents.start()` for one serial worker, versioned session events and Handoff data, deterministic hard limits, and plugin-owned targeted verification. It does not install community plugins in v0.1.

Community plugin manifests commonly use prerelease peer ranges that do not accept `0.1.1-rc.2` under npm semver rules. `dsh-lsp-actions` remains the strongest later reuse candidate; telemetry redaction remains conditional; third-party OpenAI OAuth is rejected for v0.1 because the official route exists and the candidate lacks Windows support and secure credential storage. The approved design is recorded in `docs/superpowers/specs/2026-08-27-dsh-v0.1-foundation-design.md` and awaits user review before implementation planning.

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
