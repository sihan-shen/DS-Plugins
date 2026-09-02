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
