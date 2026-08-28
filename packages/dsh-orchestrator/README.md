# `@ds-plugins/dsh-orchestrator` v0.1

`@ds-plugins/dsh-orchestrator` is an out-of-tree DeepSeek Harness (DSH) bundle for a small, evidence-first coding-agent loop. It composes with the official `@deepseek-ai/dsh-base` bundle and never replaces the DSH agent loop or provider implementation.

## Scope

v0.1 has two mutually exclusive modes:

- `direct`: one root agent; it registers `targeted_verify` and records `dsh-plugin/run-started`.
- `single-worker`: the root agent also receives one foreground `delegate_worker` action. It can start exactly one serial child and receives only a validated `HandoffV1`, never a child transcript.

The repository profile at [`../../profiles/v0.1`](../../profiles/v0.1) is a source-workspace profile. Run `pnpm install` at the repository root before loading it; its `workspace:*` dependency is intentionally not a standalone published-profile installation recipe. To use a packed or published bundle elsewhere, create a normal DSH profile with `@deepseek-ai/dsh-base` plus this bundle, then copy the equivalent `ds-orchestrator` configuration below into that profile's `cordis.patch.yml`.

The profile deliberately provides composition only. Use it beneath a DSH surface such as the official Headless or Web bundle; it does not add its own UI or provider.

## Repository development profile

```sh
nix develop --command pnpm install
nix develop --command pnpm test:profile
```

The checked-in profile selects Direct mode. Change `mode` and the matching `budgets.maxWorkers` together to select Single Worker mode:

```yaml
- id: ds-orchestrator
  config:
    workspaceRoot: .
    mode: single-worker
    worker:
      provider: openai-codex
      model: gpt-5.6-codex
      maxTokens: 32000
    budgets:
      maxWorkers: 1
      maxPluginToolActions: 24
      toolTimeoutMs: 60000
    verification:
      commands:
        - name: typecheck
          executable: pnpm
          fixedArgs: [typecheck]
          allowedArgs: none
      timeoutMs: 120000
      maxOutputBytes: 65536
```

`openai-codex` is an official DSH `dsh-llm-pi-ai` OAuth route. Sign in through the official DSH authorization surface first. This package does not implement OAuth, read token files, substitute a third-party OAuth plugin, or silently fall back to a paid API.

## Configuration contract

All top-level fields are required, unknown keys are rejected, and values are validated when the plugin loads.

| Field | Rule |
| --- | --- |
| `workspaceRoot` | Non-empty, no NUL. It is deployment-controlled and is the only working directory used by verification; a session `cwd` cannot replace it. |
| `mode` | Exactly `direct` or `single-worker`. |
| `worker.provider`, `worker.model` | Non-empty strings. |
| `worker.reasoningEffort` | Optional non-empty string retained in the WorkerSpec/event. The pinned Agent API does not receive it as an undocumented option. |
| `worker.maxTokens` | Positive integer. v0.1 has no additional schema maximum. |
| `budgets.maxWorkers` | `0` for Direct, `1` for Single Worker; no other value is valid. |
| `budgets.maxPluginToolActions` | Positive integer, maximum **32**. Counts only `targeted_verify` and `delegate_worker`, not all Harness tools or steps. |
| `budgets.toolTimeoutMs` | Positive integer, maximum **600000 ms**. |
| `verification.commands` | A command list with unique names. An executable is one non-whitespace token and `fixedArgs` is a literal string array. |
| `verification.commands[].allowedArgs` | `none` or `orchestrator-test-paths`. |
| `verification.timeoutMs` | Positive integer, maximum **600000 ms**. |
| `verification.maxOutputBytes` | Positive integer, maximum **1048576 bytes**. |

## Targeted verification

`targeted_verify` runs only a named command from `verification.commands`. It invokes direct argv (`executable`, `fixedArgs`, approved caller args) at `workspaceRoot`; it never accepts a shell string.

- `allowedArgs: none` permits no caller args.
- `allowedArgs: orchestrator-test-paths` permits only POSIX repository-relative files under `packages/dsh-orchestrator/tests/`, with no empty, `.` or `..` segments, backslashes, drive prefixes, absolute paths, NULs, or non-test extensions.
- A timeout owns process cancellation and waits for process-tree quiescence. Captured stdout/stderr are bounded with a UTF-8-safe proportional tail cap and become `VerificationEvidenceV1`.
- Caller cancellation is reported as cancellation, not overwritten as a timeout. Invalid and pre-aborted calls are rejected before consuming the plugin-action budget.

`VerificationEvidenceV1` holds `schemaVersion`, command name/args, exit code, status, bounded stdout/stderr, truncation flag, and duration. A completed Handoff with any non-passing evidence must contain the exact marker `[verification: failed]` in its summary.

## Handoff and canonical events

The parent accepts only JSON `HandoffV1`:

```text
schemaVersion, status, summary, changedFiles, decisions, verification, blockers
```

String fields are capped at **16384 UTF-8 bytes** and every Handoff array at **128 items**. Changed-file paths are slash-normalized, repository-relative, and reject traversal or absolute Windows/POSIX forms. Invalid child output becomes a fixed failed Handoff without copying raw output.

Canonical session evidence consists of versioned `dsh-plugin/` events: `run-started`, `worker-requested`, `worker-finished`, `budget-rejected`, and `verification-finished`. Events project only the configured mode/model, bounded worker spec, validated Handoff, admission counters, and verification evidence. They exclude credentials, authorization headers, tokens, raw model output, and worker transcripts.

## Official provider smoke

The opt-in smoke is intentionally keyless by default:

```sh
nix develop --command pnpm test:provider
# SKIP: set DSH_RUN_OPENAI_CODEX_SMOKE=1 to run the authorized OpenAI Codex smoke.
```

It performs no provider import or network call unless explicitly enabled. With an already authorized official DSH OpenAI Codex account, a pinned Harness source checkout, and quota, run:

```sh
DSH_RUN_OPENAI_CODEX_SMOKE=1 nix develop --command pnpm test:provider
```

`DSH_HARNESS_ROOT` may point to the pinned `deepseek-harness` checkout when it is not at `upstream/deepseek-harness`. The smoke creates a disposable fixture repository and temporary DSH profile, disables telemetry, runs a bounded Direct task and a bounded Single Worker task, and checks terminal output plus canonical event evidence. It never prints provider output, credentials, authorization headers, or token-store contents. A skipped run is **not** provider validation.

## v0.1 limitations

- One serial worker only; no parallel writes.
- The action budget counts plugin-owned tools only, not a total Harness tool or step budget.
- No adaptive routing, retry policy, model fallback, or paid-provider fallback.
- No community runtime dependency.
- The Direct and Single Worker modes, keyless Loader/replay coverage, and the skip path can be verified without a provider. A real-provider acceptance run remains required before claiming v0.1 release completion.
