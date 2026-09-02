# v0.3 Adaptive Scheduling Final Fix Report

Date: 2026-09-02
Base: `c242b64` (`fix: harden v0.3 replay gate admission and runtime flags`)
Status: `DONE_WITH_CONCERNS`

## Findings fixed

1. **Critical — scheduler absence broke Single Worker Root fallback.** `fixedProfileSchedule()` now derives `direct`/`single-worker` and worker count solely from the target. Single Worker mode remains enforced at `createDelegateWorkerTool()` and `mountSingleWorkerMode()`. Coverage: target-derived fallback unit test plus a `single-worker` + scheduling-enabled + scheduler-absent Root waterfall integration test.
2. **Important — Root durable restore bypassed all later scheduling.** `mountRootScheduling()` now hydrates the newest validated durable selection and its original `SessionEvent.time` once per Session and scheduler service generation, then calls `schedule()` on every Root step. Coverage: same-session multi-step call count, actual scheduler failure-to-next-request behavior, fake-clock exact TTL expiry, one-time hydration, and a second scheduler generation/remount.
3. **Important — Worker/session/runtime state was not fully cleaned.** The public service contract now includes optional `hydrate`, `complete`, and `disposeSession` lifecycle methods. Every resolved Worker path completes in `finally`, including completion, failed/blocked handoffs, budget rejection, cancellation, and invalid response cleanup. `complete()` clears sticky, affinity/routes, failures, escalation, cooldown, and pending history; the plugin listens to `session/disposed`; runtime disposal clears the whole state store and history. Coverage: all Worker terminal outcomes, cancellation, budget rejection, same-ID session reuse, runtime disposal, and full invocation-state reset.
4. **Important — cooldown and retry-after were inert.** Failure recording now maintains request/route cooldown deadlines, uses configured `cooldownMs`, clamps provider retry-after to 600,000 ms, filters cooled candidates even after sticky idle expiry, and allows the original route again at `now >= cooldownUntil`. Coverage: default cooldown, exact boundary, retry-after override, excessive retry-after cap, and idle-before-cooldown expiry.
5. **Important — scheduler operational errors were reclassified as invalid decisions.** `resolveSchedule()` now awaits the scheduler outside the response parsing/route-validation catch. Only returned-value parse or hard-route validation failures use `allowInvalidDecisionFallback`; typed quota/auth/local-budget/safety errors and cancellation retain identity. Coverage: fallback enabled and disabled, all listed operational codes, and cancellation race.
6. **Minor — mixed history overstated provenance.** A history snapshot is now `verified` only when every retained sample has passing verification; mixed verified/unverified or failed samples are `observed`. Coverage: a two-sample mixed window regression.
7. **Minor — Root routing design text was stale.** The design's old no-rewrite statement is explicitly marked superseded by Task 8 and now documents `agent/request` enforcement while retaining actual-header-only `run-started` semantics.
8. **Minor — HANDOFF Next Step was stale.** It now records Tasks 1–9 and this final fix wave as complete, with scoped re-review, normal-environment lockfile regeneration, and merge as the next sequence.

## TDD evidence

- Orchestrator RED: `scheduling.spec.ts` failed 9/25 for target fallback, operational error propagation, per-step Root scheduling, and hydration.
- Lifecycle/cooldown/history RED: 5 focused files failed 14/74 for terminal cleanup, session/runtime disposal, hydration, cooldown, retry-after, and weakest evidence.
- Idle-before-cooldown RED: `escalation.spec.ts` failed 1/16 because the cooled baseline was reused after sticky idle expiry.
- GREEN after minimal fixes: combined focused suite passed 6 files / 99 tests; Adaptive Scheduler suite later passed 6 files / 57 tests after the additional cooldown boundary.

## Fresh verification

Commands use `/home/sihan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node` because no global Node is available.

- `node node_modules/typescript/bin/tsc -b` — exit 0.
- `node --expose-internals node_modules/vitest/vitest.mjs run packages/dsh-orchestrator/tests packages/dsh-adaptive-scheduler/tests tests/replay --config vitest.config.ts` — 22 files / 219 tests passed.
- `node --expose-internals node_modules/vitest/vitest.mjs run --config vitest.config.ts` — 44 files / 434 tests passed; only the 2 known `tests/provider/openai-codex.smoke.spec.ts` child-stdout assertions failed because sandbox-spawned stdout is empty.
- `node --experimental-strip-types tests/provider/openai-codex.smoke.ts` — exit 0 and emitted exactly `DISABLED: local OpenAI Codex provider smoke is intentionally unavailable; keyless verification only.`
- `git diff --check` — exit 0.
- `git diff --quiet -- profiles/v0.1/package.json profiles/v0.1/cordis.patch.yml` — exit 0.

## Concerns and deferred work

- `pnpm-lock.yaml` remains deferred exactly as instructed. The sandbox cannot use pnpm's SQLite store or registry path, so no lock content was fabricated; regenerate and verify it in a normal pnpm environment before merge.
- The two full-suite provider smoke failures are the pre-existing sandbox child-stdout capture artifact. The direct smoke command passes with the exact disabled message. No provider, credential, endpoint, paid call, network, raw transcript, or real coding-task behavior was exercised.
- Independent subagent review was unavailable in this tool environment; a controller-level scoped diff audit found no remaining Critical or Important issue. The requested external scoped re-review remains the next gate.
