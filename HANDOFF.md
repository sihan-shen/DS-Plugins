# Handoff

## Goal

Define a DSH-based personal Coding Agent plugin architecture that is ChatGPT/Codex-first, context-efficient, selectively multi-agent, and evidence-driven; establish a reusable Direnv + Home Manager DeepSeek Harness development environment for that work.

## Current Status

`README.md` records the full architecture baseline: lifecycle, component boundaries, data contracts, scheduling rules, prompt/cache behavior, code intelligence, memory, verification, telemetry, safety, a three-tier plugin reuse analysis, configuration, v0.1-v0.6 roadmap, and measurable hypotheses.

The repository now also provides a Nix Flake with a Node.js 24 development shell, a reusable `homeManagerModules.deepseek-harness-dev` module that only enables `direnv` and `nix-direnv`, and an `.envrc` containing only `use flake`. The shell supplies a `dsh-pnpm-wrapper` that invokes Node.js 24's `corepack pnpm`, takes PATH precedence over unrelated pnpm binaries, and preserves the upstream `packageManager` selection without writing shims into the Nix store. It also supplies `dsh-web`, which locates the repository-local Harness checkout and applies the required Nix Node compatibility launch automatically. The shell resolves `DSH_HOME` by walking upward for the DS-Plugins marker pair, so an independently cloned nested Harness Git checkout still uses the repository-local `.dsh`. `.gitignore` excludes direnv cache, that local state, and the upstream checkout. Harness remains a source-run dependency, not a global npm or Nix installation.

Task 1 adds the DSH v0.1 pnpm workspace, a minimal ESM `@ds-plugins/dsh-orchestrator` bundle, and the private `@ds-plugins/dsh-v0.1-profile`. The bundle's `cordis.patch.yml` inserts `ds-orchestrator`; the profile's user layer is `profiles/v0.1/cordis.patch.yml`, which selects Direct mode, `maxWorkers: 0`, bounded action/verification limits, and only `typecheck` plus `test:profile` verification commands. The profile pins `@deepseek-ai/dsh-base` to `0.1.1-rc.2`; Cordis and the official patch test support use exact versions from the pinned upstream manifests. pnpm's reviewed build policy permits only the required native Harness/test dependencies and rejects unneeded lifecycle scripts.

Task 2 adds versioned public types, load-time `parseConfig(value: unknown): OrchestratorConfig`, a Cordis standard-schema `Config` entry, and bounded `parseHandoff(value, workspaceRoot): HandoffV1` projection. Configuration rejects unknown keys, shell-string executables, duplicate verification names, invalid mode/worker limits, and values above the documented maxima. The profile now names verification prefixes `fixedArgs`, matching the schema. Handoff validation accepts JSON-only v1 records, normalizes safe changed-file paths to `/`, rejects absolute and traversal paths across POSIX and Windows syntax, and never copies invalid worker output into a fallback handoff. A completed result with any non-passing verification must include the exact, case-sensitive marker `[verification: failed]` in its summary.

Task 3 adds five non-ignorable, declaration-merged `dsh-plugin/` session events: run started, worker requested, worker finished, budget rejected, and verification finished. The append helpers return the actual Harness sequence number, project typed input into fresh JSON-only payloads, omit unrecognized fields such as authorization, tokens, and transcripts, and detach nested readonly arrays and objects before appending. The orchestrator now has exact `@deepseek-ai/dsh-session` peer and development dependencies, and focused tests prove event order, payload snapshots, JSON round trips, sensitive-key omission, and effect-scoped event-projection disposal/remount behavior. Its `prepack` hook builds the bundled entry; `test:package-entry` builds first and then imports the package name to assert all five helpers, preventing a stale ignored `lib/` entry from shipping those exports absent.

Task 4 adds deterministic session-scoped budget admission. `BudgetController` synchronously admits one plugin-owned worker counter and one shared plugin-action counter, rejects without incrementing, and only recognizes `delegate_worker` plus `targeted_verify`; unknown action names throw. Rejections are dependency-recorded with stable `WORKER_LIMIT`, `PLUGIN_TOOL_LIMIT`, or `DISPOSED` codes and the configured limit plus next non-incremented observation. A root-`SessionId` registry isolates controllers, clears terminal session state through `session/disposed`, and disposes all controllers/listeners with the Cordis effect so HMR remounts start empty. The bundle entry maps active-root rejections to the durable `appendBudgetRejected` event.

Task 5 adds targeted verification. `VerificationService.run(commandName, args, signal)` admits only configured executable/fixed-argument/allowed-argument combinations, spawns direct argv at the repository root through exact `@deepseek-ai/dsh-subprocess@0.1.1-rc.2`, owns its timeout signal, awaits process-tree quiescence in `finally`, and appends bounded `verification-finished` evidence for every admitted result. The profile now declares `allowedArgs`: `typecheck` permits no caller arguments and `test:profile` permits only safe repository-relative `packages/dsh-orchestrator/tests/` test files. Captured stream collectors cap each stream while durable evidence applies a UTF-8-safe proportional tail cap across both streams. Caller cancellation records its actual non-timeout process outcome before rethrowing the caller reason; it is not mislabeled as a timeout. The generic `targeted_verify` ToolDefinition admits its `BudgetController` action before spawning and is registered through a Cordis effect for teardown/HMR safety. Exact `dsh-subprocess` and `dsh-tools` peer/dev dependencies are locked at `0.1.1-rc.2`.

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
- Task 1 RED: before the root manifest existed, `nix develop --command pnpm exec vitest run packages/dsh-orchestrator/tests/profile.spec.ts` exited 1 with `ERR_PNPM_RECURSIVE_EXEC_NO_PACKAGE`, proving the profile test could not run without a workspace. GREEN: `nix develop --command pnpm install`, the focused Vitest profile test, and `nix develop --command pnpm typecheck` all exited 0. The root test and build scripts also exited 0; the profile's workspace dependency imported the built ESM bundle successfully after its manifest was aligned with tsdown's `.mjs` output.
- Task 2 followed RED/GREEN cycles for missing configuration and handoff modules, then corrected a JSON-array guard and NodeNext-only typecheck issues before the final run. The final controller-run command `nix develop --command pnpm exec vitest run packages/dsh-orchestrator/tests/config.spec.ts packages/dsh-orchestrator/tests/handoff.spec.ts packages/dsh-orchestrator/tests/profile.spec.ts` exited 0 with 25/25 tests passing; `nix develop --command pnpm typecheck` (`tsc -b`) exited 0. A real-profile configuration regression test first failed because the profile used unsupported `args`; it passed after the profile and expectation changed to `fixedArgs`.
- Task 3 RED: `nix develop --command pnpm exec vitest run packages/dsh-orchestrator/tests/events.spec.ts` exited 1 before the Session peer was declared: Vitest reported `Cannot find package '@deepseek-ai/dsh-session' imported from .../tests/events.spec.ts`, with one failed test file and no executed tests. After adding the exact Session peer/dev dependency and durable helpers, `nix develop --command pnpm install` exited 0 (`Scope: all 3 workspace projects`, supply-chain policies verified, already up to date, and the existing deprecated `node-domexception@1.0.0` transitive warning); the focused event test exited 0 with 3/3 tests passing; `nix develop --command pnpm typecheck` (`tsc -b`) exited 0 without errors.
- Task 3 review fix: the package-name entry initially exposed stale ignored `lib/index.mjs` output, so a focused package-name import test failed because `appendRunStarted` was undefined. The package now runs the build from `prepack` and from `test:package-entry` before the smoke import; controller verification rebuilt `lib/index.mjs` and declarations, passed the event suite (3/3), passed the package smoke (1/1), and passed `tsc -b`. Generated `lib/` remains ignored and uncommitted by established workspace policy.
- Task 4 RED: `nix develop --command pnpm exec vitest run packages/dsh-orchestrator/tests/budgets.spec.ts` exited 1 because the intended `../src/budgets.ts` module was absent, with one failed test file before test execution. Initial GREEN exercised five of six behavioral tests but failed only on an invalid `ctx.dispose()` teardown in the test harness; Cordis owns teardown through the Fiber returned from `ctx.plugin`, so the test now disposes its real SessionStore Fiber. Final controller verification passed the budget suite (6/6, one file) and `nix develop --command pnpm typecheck` (`tsc -b`) exited 0. `git diff --check` exited 0.
- Task 5 RED: `nix develop --command pnpm exec vitest run packages/dsh-orchestrator/tests/verification.spec.ts` exited 1 because `../src/verification.ts` was absent; Vitest reported one failed test file before test execution. `nix develop --command pnpm install` then exited 0 with only the existing `node-domexception` warning. Final controller verification passed `verification.spec.ts` (15) plus `budgets.spec.ts` (6), `nix develop --command pnpm typecheck` (`tsc -b`) exited 0, and `nix develop --command pnpm --filter @ds-plugins/dsh-orchestrator run test:package-entry` built the entry and passed its 1/1 import smoke. `git diff --check` exited 0.

## Next Step

Continue `docs/superpowers/plans/2026-08-27-dsh-v0.1-foundation.md` with Task 6. Actual Cordis Loader composition, prompt/mode execution, subagent execution, and real verification-process execution remain later tasks. Track an upstream fix for `node-addon-require-builtin` on Nix Node so the local `dsh-web` compatibility wrapper can eventually return to the standard launch path.

## v0.1 Design Status (2026-08-27)

The shortlisted plugins and the DSH `0.1.1-rc.2` extension points were validated through three independent read-only reviews. The resulting design uses the official `dsh-llm-pi-ai` `openai-codex` OAuth path, a single out-of-tree orchestrator plugin, `ctx.subagents.start()` for one serial worker, versioned session events and Handoff data, deterministic hard limits, and plugin-owned targeted verification. It does not install community plugins in v0.1.

Community plugin manifests commonly use prerelease peer ranges that do not accept `0.1.1-rc.2` under npm semver rules. `dsh-lsp-actions` remains the strongest later reuse candidate; telemetry redaction remains conditional; third-party OpenAI OAuth is rejected for v0.1 because the official route exists and the candidate lacks Windows support and secure credential storage. The approved design is recorded in `docs/superpowers/specs/2026-08-27-dsh-v0.1-foundation-design.md`; its task-level implementation plan is `docs/superpowers/plans/2026-08-27-dsh-v0.1-foundation.md`.

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
