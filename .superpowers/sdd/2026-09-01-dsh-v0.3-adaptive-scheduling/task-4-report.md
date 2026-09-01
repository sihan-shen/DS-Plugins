# Task 4 Report: Generation-Safe Adaptive Scheduling State

## Status

Implementation complete in the scoped `@ds-plugins/dsh-adaptive-scheduler` package. The package now has generation-safe session route state, worker affinity profiles, deterministic failure escalation, and bounded route-switch evidence.

Commit: `a0f585d feat: add adaptive scheduling state machine`

## Implementation

- Added `SchedulerStateStore` with immutable sticky state, fixed TTL and sliding idle TTL, generation checks, bounded failure records, escalation expiry, frozen worker affinity, completion cleanup, and a maximum 64 route-switch history.
- Extended scheduler types with provider failure facts/codes, sticky route state, worker affinity state, and route-switch records.
- Updated `createAdaptiveScheduler` to preserve the Task 3 safety/budget/catalog policy while applying deterministic state precedence:
  - QUOTA → `QUOTA_EXHAUSTED`.
  - AUTH → `NON_TRANSIENT_FAILURE`.
  - transient failure → one compatible fallback, then a bounded strong route.
  - error-window failures beyond `maxRounds` → `ESCALATION_ROUNDS_EXHAUSTED`.
  - escalation TTL expiry → baseline/default selection with `TTL_EXPIRED` evidence.
  - sticky reuse → `STICKY_ROUTE`; fixed or idle expiry is generation-local and records the switch reason when the route changes.
- Kept route decisions validated and deeply frozen through the existing scheduling-contract parser; generation remains in `affinityKey`.
- Exported the new runtime/state types and `SchedulerStateStore` from the package entry.

## TDD evidence

### RED

Added `state.spec.ts` and `escalation.spec.ts` before production implementation. The first direct cached-Node run exited 1 with 2 files, 17 collected tests, 6 failures, and 11 passes. The failures were the expected missing sticky behavior and missing `recordFailure`/`switches` API; the existing policy tests imported by the fixtures remained green.

### GREEN

After the minimal implementation, the required focused command passed:

```text
3 test files passed
22 tests passed
```

The package typecheck exited 0. The state suite also passed 7/7 in three independent invocations. Vitest 4.0.18 rejects the brief's `--repeat=3` option with `CACError: Unknown option --repeat`; the three direct runs were used as the equivalent deterministic repetition.

The root cached-Node project-reference typecheck exited 0, and `git diff --check` exited 0.

## Changed files

- `packages/dsh-adaptive-scheduler/src/state.ts` — new state store.
- `packages/dsh-adaptive-scheduler/src/scheduler.ts` — state-aware scheduling and escalation.
- `packages/dsh-adaptive-scheduler/src/types.ts` — Task 4 public types.
- `packages/dsh-adaptive-scheduler/src/index.ts` — exports.
- `packages/dsh-adaptive-scheduler/tests/state.spec.ts` — sticky/generation/affinity tests.
- `packages/dsh-adaptive-scheduler/tests/escalation.spec.ts` — failure policy/bounds/switch tests.
- `HANDOFF.md` — project handoff update.

## Self-audit findings

- The existing `policy.spec.ts` exports `schedulerConfig`, `request`, and `budget`, but not the brief's referenced `signal`; the new tests use a local `new AbortController().signal` and leave the existing policy fixture unchanged.
- The requested `--repeat=3` CLI option is unavailable in the cached Vitest 4.0.18, so repeated independent executions provide the recorded substitute.
- No subagent or separate code-review workflow was used, per the task instruction. Objective diff, typecheck, focused test, repetition, and whitespace checks were performed.

## Concerns / unverified items

- The full monorepo test suite and package-entry build were not part of Task 4's scoped verification and were not run.
- The known pnpm SQLite/registry sandbox limitation remains; all verification used the supplied cached Node direct commands.
- No provider, credential, network, live runtime, or paid route was exercised.

## Review follow-up (2026-09-01)

The review findings are fixed in the follow-up commit:

- Worker affinity is keyed by the JSON tuple `(generation, taskId, workerId)`. Repeated freezes return the original immutable profile, so route, tool-filter, and token-slice data cannot be overwritten by a later candidate; the frozen route snapshot is used by repeated scheduler calls. Profiles from another task or generation are not reused, and `scheduler.complete(requestId)` removes the invocation's affinity state and route snapshot.
- Sticky and escalation expiry now use `now >= expiresAt`. Tests cover fixed TTL expiry at the exact boundary and escalation TTL expiry at the exact boundary.
- Removed the unused `vi` import and simplified `failuresSinceSelection()` by removing its unused state parameter.
- HANDOFF.md is included in the follow-up commit so the documented Task 4 state matches the committed files.

### Review verification

```text
node node_modules/vitest/vitest.mjs run packages/dsh-adaptive-scheduler/tests --config vitest.config.ts
3 test files passed; 27 tests passed

node node_modules/vitest/vitest.mjs run packages/dsh-adaptive-scheduler/tests/state.spec.ts --config vitest.config.ts
1 test file passed; 11 tests passed (three independent runs)

node node_modules/typescript/bin/tsc -b packages/dsh-adaptive-scheduler
node node_modules/typescript/bin/tsc -b
git diff --check
all exited 0
```

The pnpm wrapper remains unverified because of the known sandbox SQLite/registry limitation. No provider, credential, network, live runtime, or paid route was exercised.
