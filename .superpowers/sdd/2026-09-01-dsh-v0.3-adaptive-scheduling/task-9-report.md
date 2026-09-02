# Task 9 report: complete keyless replay coverage and v0.3 gate

Date: 2026-09-02
Commit base: `10593ac`

## Implementation

- Added `tests/replay/adaptive-scheduling.fixture.ts` with deterministic fake-clock scheduling coverage. It loads and validates the checked-in v0.3 profile, uses real `BudgetController` snapshots, exercises profile fallback, scheduler-present selection, invalid-decision rejection without admission, quota rejection, transient fallback/cooldown/repeated escalation, failed-Handoff escalation, worker event ordering, root event ordering, and the actual disabled route.
- Added `tests/replay/adaptive-scheduling.snapshot.spec.ts` with the brief's exact routes, error code, counters, event order, budget view, and sensitive-output scan.
- Added `replayScheduledDirectFixture()` to `tests/replay/direct.fixture.ts`. It mounts real Direct root scheduling and run-start event behavior over a real Session/SessionStore, then returns the actual `request/header` route as `{ provider: 'actual-disabled', model: 'actual-model-disabled' }`.
- Extended `tests/replay/orchestrator.snapshot.spec.ts` with the scheduled Direct event-order assertion.
- Added the `test:v0.3` script and expanded root `build` to build contracts, Adaptive Scheduler, and Orchestrator in order.
- Added root Vitest aliases needed by root-level replay files for workspace source packages, pinned runtime packages, and the existing orchestrator-local `js-yaml@4.1.0` dependency.
- Updated the README v0.3 section to mark the keyless gate implemented and document the permanent provider-disabled boundary.
- Updated `HANDOFF.md` with this task's status and evidence.

The existing root `tsconfig.json` already referenced `dsh-scheduling-contracts`, `dsh-adaptive-scheduler`, and `dsh-orchestrator`; no tsconfig edit was needed. `pnpm-lock.yaml` was intentionally unchanged.

## TDD evidence

1. RED: created the exact replay matrix spec before the fixture. Cached-Node Vitest failed during suite loading with `Cannot find module './adaptive-scheduling.fixture.ts'`, as required.
2. GREEN: implemented the minimal fixture and direct replay integration. Focused `tests/replay/adaptive-scheduling.snapshot.spec.ts` passed 1/1.
3. Replay regression: `tests/replay` passed 4 files / 21 tests.

The fixture uses a no-affinity request for failure/Handoff branches because the existing scheduler's Worker Affinity contract intentionally freezes repeated worker routes. The initial worker capability request still includes the exact brief affinity value; this keeps the failure-policy assertions aligned with the scheduler's documented same-task fallback behavior while preserving the acceptance values.

## Verification

All commands below used cached Node v24.19.0 unless noted.

| Check | Result |
|---|---|
| Focused RED replay | Failed as expected: missing fixture module |
| Focused GREEN replay | 1 file / 1 test passed |
| Replay regression | 4 files / 21 tests passed |
| v0.3 equivalent gate | 24 files / 238 tests passed |
| v0.2c equivalent regression | 36 files / 334 tests passed |
| Root `tsc -b` | exit 0 |
| contracts + scheduler build | exit 0 |
| orchestrator tsdown build | exit 0 |
| profile test | 2/2 passed |
| provider safety command | exit 0; emitted only the fixed `DISABLED` message |
| `git diff --check` | exit 0 |
| v0.1 package/patch unchanged check | exit 0 |
| `package.json` parse | valid |

The exact `pnpm test:v0.3` command was attempted and failed before executing the script because the sandbox could not open pnpm's SQLite database and pnpm attempted registry metadata access. The equivalent cached-Node build plus Vitest command passed. No lockfile generation was attempted after that failure.

## Changed files

- `.superpowers/sdd/2026-09-01-dsh-v0.3-adaptive-scheduling/task-9-report.md`
- `HANDOFF.md`
- `README.md`
- `package.json`
- `tests/replay/adaptive-scheduling.fixture.ts`
- `tests/replay/adaptive-scheduling.snapshot.spec.ts`
- `tests/replay/direct.fixture.ts`
- `tests/replay/orchestrator.snapshot.spec.ts`
- `vitest.config.ts`

## Self-audit findings

- The existing Single Worker replay intentionally includes a fourth `dsh-plugin/budget-rejected` event after the successful three-event worker lifecycle. The v0.3 matrix projects only the successful worker sequence required by the brief; the existing orchestrator snapshot continues to assert the budget rejection separately.
- The direct replay's `actualRoute` is taken from the actual disabled `request/header`, and the run-started event is asserted against that same route. The scheduler-selected route remains separately present as the first durable event.
- The root TypeScript project references required by v0.3 were already present, so changing `tsconfig.json` would have been redundant.

## Concerns

- Direct pnpm workspace commands remain unavailable in this sandbox due SQLite/registry restrictions. Equivalent cached-Node commands provide the executable evidence; pnpm lockfile behavior remains unverified.
- Root-level replay imports require the Vitest aliases documented above because the pinned runtime packages are installed under the orchestrator workspace rather than as root dependencies. No new dependency was introduced.
- Provider, credentials, network isolation, quota/cost endpoints, raw transcripts, and real coding-task acceptance remain intentionally unverified by this keyless gate.

## Review follow-up (2026-09-02)

- Replaced the detached invalid-decision check with `replayInvalidWorkerDecisionFixture()`, which executes the real `createDelegateWorkerTool`/`delegate_worker` path with a session-scoped budget registry and an invalid scheduler route. The replay now asserts unchanged admission counters, zero child starts, and an empty durable event list; this proves rejection occurs before action/worker admission, event publication, or child publication.
- Changed `test:v0.3` to launch Vitest through `node --expose-internals`, matching the root `test` loader behavior. Added exact root devDependencies for the direct replay imports (`@deepseek-ai/cordis@4.0.1`, `@deepseek-ai/dsh-agent@0.1.1-rc.2`, and `js-yaml@4.1.0`) and removed the Vitest aliases that pointed at Orchestrator-private `node_modules`.
- `replayScheduledDirectFixture()` now derives `actualRoute` by parsing the recorded `request/header` event. The adaptive replay also retains complete worker/root event payload projections and scans those payloads for sensitive markers, while the existing Single Worker snapshot continues to assert the full valid Handoff/context result.
- `tsconfig.json` was inspected against the brief: all three v0.3 project references were already present, so no redundant hunk was made. `pnpm-lock.yaml` was not changed because pnpm lock generation remains blocked by the sandbox SQLite/registry limitation; the new manifest dependency intent is recorded here.
- README now states that the v0.3 gate evidence is from the equivalent cached-Node command because the exact pnpm command could not execute in this sandbox.

### Review follow-up verification

All commands below used cached Node `v24.19.0` with `PATH=/home/sihan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH`:

| Check | Result |
|---|---|
| Invalid-decision RED regression | Failed as expected before fixture update: missing `childStarts` and `events` assertions |
| Focused adaptive replay GREEN | 1 file / 1 test passed |
| Replay regression | 4 files / 21 tests passed |
| Complete v0.3 equivalent gate | 24 files / 238 tests passed using `node --expose-internals node_modules/vitest/vitest.mjs run packages/dsh-scheduling-contracts/tests packages/dsh-adaptive-scheduler/tests packages/dsh-orchestrator/tests tests/replay --config vitest.config.ts` |
| Root project-reference typecheck | `node node_modules/typescript/bin/tsc -b` exited 0 |
| `git diff --check` | passed |
| Manifest parse | passed |

The exact `pnpm test:v0.3` command remains unverified because pnpm cannot open its sandbox SQLite store and attempts registry metadata access. No provider, credential, endpoint, transcript, paid call, or network behavior was introduced or exercised.
