# Governance Resolver and Evaluator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the pure v0.6 runtime that binds supplied governance evidence to the compiled revision-1 policy/corpus, derives offline evaluation results, and independently replays candidate-support selection.

**Architecture:** Keep the runtime inside `@ds-plugins/dsh-eval/governance`. `resolver.ts` accepts only bounded in-memory snapshots and derives authoritative run/pair accounting; `evaluator.ts` derives policy metrics, comparisons, and result from resolved evidence; `candidate-support.ts` replays the v0.5 failure-only cohort and deterministic evidence-selection rules. These modules consume the existing detached validators and frozen policy/corpus constants, never filesystem, provider, network, clock, profile, or telemetry-builder code.

**Tech Stack:** TypeScript, existing governance canonicalization and validators, frozen policy/corpus constants, pure telemetry contract types, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-06-dsh-v0.6-offline-governance-design.md`

## Global Constraints

- Governance remains pure and in-memory; no filesystem, provider, network, environment, clock, profile, routing, permission, or credential access.
- Revision-1 policy and corpus are compiled authority; a self-consistent caller-supplied manifest or policy digest is insufficient.
- Raw inputs remain subject to canonical byte admission; object inputs are detached snapshots and never mutate caller data.
- Every derived count, metric, pair, comparison, and result is recomputed; caller-supplied derived assertions must match exactly or fail.
- Missing or incomplete prescribed runs produce `incomplete`; an available metric failure takes precedence over incompleteness; unavailable required metrics cannot pass.
- Candidate support must replay v0.5 failure attribution, cohort identity, minimum support, diversity-preserving first-32 selection, evidence fill, rule mapping, and all pattern/lesson/candidate hashes.
- Governance must not import `telemetry/candidates.ts`, `telemetry/lessons.ts`, `mineFailures`, `buildCandidates`, filesystem helpers, or the main `dsh-eval` entry.
- Enforce the existing bounds before copying, sorting, hashing, indexing, or allocating derived arrays; all errors are fixed-code and bounded.

---

### Task 1: Authoritative Offline Evidence Resolver

**Files:**
- Create: `packages/dsh-eval/src/governance/resolver.ts`
- Create: `packages/dsh-eval/tests/governance/resolver.spec.ts`
- Modify: `packages/dsh-eval/src/governance/index.ts`
- Modify: `packages/dsh-eval/tests/governance/contracts.spec.ts`

**Interfaces:**
- Consumes: `OfflineEvidenceResolverInputV1`, `ResolvedRunEvidenceV1`, `TemplateOfflineFixtureDefinitionV1`, `TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST`, `TEMPLATE_OFFLINE_V1_POLICY_REF`, and the existing `validate*` functions.
- Produces: `resolveOfflineEvidence(input: OfflineEvidenceResolverInputV1): EvaluationEvidenceV1`.
- `resolveOfflineEvidence` validates the supplied snapshot, compares the supplied manifest and policy identity to the compiled authoritative constants, then derives both arms, pairs, metric inputs, comparisons, and result without trusting serialized derived fields.

- [ ] **Step 1: Add failing resolver fixtures for authority and prescribed identity.**

  Build pure fixtures from the checked-in corpus definitions and telemetry contract validators. Cover one complete base/variant snapshot per manifest fixture, exact arm artifact hashes, task-family/task-instance identity, same-domain and ordered cross-domain pairs, and a self-consistent substituted manifest whose digest is recomputed.

- [ ] **Step 2: Run the resolver tests to verify the new behavior is absent.**

  Run:

  ```bash
  ./node_modules/.bin/vitest run packages/dsh-eval/tests/governance/resolver.spec.ts --config vitest.config.ts
  ```

  Expected: FAIL because `resolveOfflineEvidence` is not exported yet and no runtime derivation exists.

- [ ] **Step 3: Implement bounded authority and run admission.**

  Validate the detached resolver input, require canonical equality with `TEMPLATE_OFFLINE_V1_CORPUS_MANIFEST`, require the compiled policy identity where evidence carries it, and index only bounded prescribed snapshots. Reject duplicate domain-qualified runs, unprescribed tuples, wrong-arm domain bindings, wrong task identity, wrong artifact hashes, malformed cross-run references, lossy seals, ordinal gaps, and unresolved annotation evidence. Treat omitted or structurally incomplete prescribed snapshots as incomplete only after structural admission succeeds.

- [ ] **Step 4: Derive arms and pairs in manifest order.**

  For each fixture derive `fixtureRuns`, `resolvedRuns`, `completeRuns`, `incompleteRuns`, `excludedRuns: 0`, and the ordered `runs` list. Include a pair only when both prescribed snapshots are complete. Pass the derived complete-run observations to the evaluator boundary without copying caller-derived counts or arrays.

- [ ] **Step 5: Implement the minimal evaluator seam and exact resolver assertions.**

  Keep resolver-specific accounting in `resolver.ts`; call the evaluator only with the derived arm state. Require the returned policy/corpus identity, metrics, comparisons, and result to be canonically consistent with the evidence object. Do not add proposal or ledger transitions in this task.

- [ ] **Step 6: Run focused resolver and governance validation.**

  ```bash
  ./node_modules/.bin/vitest run packages/dsh-eval/tests/governance/resolver.spec.ts packages/dsh-eval/tests/governance/contracts.spec.ts --config vitest.config.ts
  ./node_modules/.bin/tsc --noEmit -p packages/dsh-eval/tsconfig.governance-tests.json
  ```

- [ ] **Step 7: Commit.**

  ```bash
  git add packages/dsh-eval/src/governance/resolver.ts packages/dsh-eval/src/governance/index.ts packages/dsh-eval/tests/governance/resolver.spec.ts
  git commit -m "feat(dsh-eval): resolve authoritative offline evidence"
  ```

### Task 2: Policy Evaluator and Derived Metrics

**Files:**
- Create: `packages/dsh-eval/src/governance/evaluator.ts`
- Create: `packages/dsh-eval/tests/governance/evaluator.spec.ts`
- Modify: `packages/dsh-eval/src/governance/index.ts`
- Modify: `packages/dsh-eval/tests/governance/resolver.spec.ts`

**Interfaces:**
- Consumes: the resolver’s derived arm/pair state and `TEMPLATE_OFFLINE_V1_POLICY`.
- Produces: `evaluateGovernanceEvidence(evidence: EvaluationEvidenceV1): EvaluationEvidenceV1` and the resolver integration used by `resolveOfflineEvidence`.
- The evaluator derives the three fixed metrics in policy order, exact comparison formulas, unavailable sentinels, and precedence `failed > incomplete > passed` after structural rejection.

- [ ] **Step 1: Add failing metric and precedence fixtures.**

  Cover successful-known-outcome rate, explicit-acceptance rate, verification duration cost, absent duration, explicit zero, exact maximum duration, overflow at maximum plus one, required-unavailable, optional-unavailable, a threshold failure combined with omission, and altered serialized metric/comparison/result assertions.

- [ ] **Step 2: Run evaluator tests to verify the new behavior is absent.**

  ```bash
  ./node_modules/.bin/vitest run packages/dsh-eval/tests/governance/evaluator.spec.ts --config vitest.config.ts
  ```

  Expected: FAIL because `evaluateGovernanceEvidence` is not exported yet.

- [ ] **Step 3: Implement policy-derived metric accumulation.**

  Recompute numerators, denominators, values, observed/eligible coverage, and basis from complete resolved runs and annotations. Use checked addition and multiplication before accumulation or allocation. Latch verification overflow to the exact all-zero unavailable sentinel with `eligibleRuns` preserved as specified; callers cannot choose overflow or availability behavior.

- [ ] **Step 4: Implement exact comparisons and result precedence.**

  Compare higher-is-better metrics with `deltaGte`, lower-is-better cost with `variantLteBaseTimes`, emit both-null unavailable comparisons, and return `failed` before `incomplete` when any available metric fails. Require full pair coverage and all required metrics for `passed`.

- [ ] **Step 5: Reject altered derived evidence.**

  Validate the supplied evidence shape, recompute every arm metric, pair, comparison, and result, and compare canonical snapshots. Reject unknown metrics, reordering, stale policy/corpus identity, stale counts, non-null overflow comparisons, and caller-supplied derived fields that disagree.

- [ ] **Step 6: Run focused evaluator, resolver, build, and type checks.**

  ```bash
  ./node_modules/.bin/vitest run packages/dsh-eval/tests/governance --config vitest.config.ts
  ./node_modules/.bin/tsc --noEmit -p packages/dsh-eval/tsconfig.governance-tests.json
  ./node_modules/.bin/tsc -b packages/dsh-eval/tsconfig.json
  git diff --check
  ```

- [ ] **Step 7: Commit.**

  ```bash
  git add packages/dsh-eval/src/governance/evaluator.ts packages/dsh-eval/src/governance/resolver.ts packages/dsh-eval/src/governance/index.ts packages/dsh-eval/tests/governance/evaluator.spec.ts packages/dsh-eval/tests/governance/resolver.spec.ts
  git commit -m "feat(dsh-eval): evaluate governed offline evidence"
  ```

### Task 3: Candidate-Support Replay

**Files:**
- Create: `packages/dsh-eval/src/governance/candidate-support.ts`
- Create: `packages/dsh-eval/tests/governance/candidate-support.spec.ts`
- Modify: `packages/dsh-eval/src/governance/index.ts`

**Interfaces:**
- Consumes: `CandidateV1`, `CandidateSupportV1`, `TemplateArtifactV1`, pure telemetry contract validators, `FAILURE_CLASSES`, and `sha256Canonical`.
- Produces: `resolveCandidateSupport(candidate: CandidateV1, support: CandidateSupportV1, baseArtifact: TemplateArtifactV1): CandidateSupportV1`.
- The resolver returns a detached, canonically equivalent support snapshot only after replaying the complete supplied pool and verifying candidate/pattern/lesson identities. It never calls v0.5 candidate or lesson builders.

- [ ] **Step 1: Add failing positive and negative support pools.**

  Cover reviewed failure attribution for every supported category, observed budget exhaustion with a referenced `budget-rejected` observation, success/unknown rejection, unsupported observed categories, unresolved general/failure evidence, cross-domain references, duplicate/incomplete/lossy runs, fewer than three runs, one task instance, and a 40-run diversity pool where the final alternate task instance replaces the 32nd run.

- [ ] **Step 2: Run candidate-support tests to verify the replay is absent.**

  ```bash
  ./node_modules/.bin/vitest run packages/dsh-eval/tests/governance/candidate-support.spec.ts --config vitest.config.ts
  ```

  Expected: FAIL because `resolveCandidateSupport` is not exported yet.

- [ ] **Step 3: Implement complete pool admission and eligibility.**

  Validate every supplied run as complete and lossless, require failure annotations, enforce one `(domainRef, runRef)` per pool, and resolve both annotation evidence arrays. For reviewed attribution use sorted unique failure evidence; for observed attribution permit only `budget_exhaustion` references resolving to `budget-rejected` observations.

- [ ] **Step 4: Implement cohort identity and deterministic selection.**

  Require one shared domain, task family, config hash, prompt hash, and failure category, at least three runs and two task instances, then sort by ASCII `runRef`, take the first 32, replace the last only when needed for task diversity, and sort the selected set again. Seed evidence with the first eligible reference from each selected run, fill from the sorted union to 32, and require 3..32 unique references covering every selected run.

- [ ] **Step 5: Recompute support, lesson, pattern, and candidate identity.**

  Rebuild the exact pattern, lesson, and candidate hash preimages from the spec, map categories to the four fixed review rules, require candidate evidence and domain-qualified support evidence to equal the selected evidence, and require candidate base hashes to equal `baseArtifact`.

- [ ] **Step 6: Run focused candidate-support, purity, build, and mutation checks.**

  ```bash
  ./node_modules/.bin/vitest run packages/dsh-eval/tests/governance --config vitest.config.ts
  ./node_modules/.bin/tsc --noEmit -p packages/dsh-eval/tsconfig.governance-tests.json
  ./node_modules/.bin/tsc -b packages/dsh-eval/tsconfig.json
  git diff --check
  ```

- [ ] **Step 7: Commit.**

  ```bash
  git add packages/dsh-eval/src/governance/candidate-support.ts packages/dsh-eval/src/governance/index.ts packages/dsh-eval/tests/governance/candidate-support.spec.ts
  git commit -m "feat(dsh-eval): replay governed candidate support"
  ```

### Task 4: Runtime-Slice Review Gate

**Files:**
- Modify: `packages/dsh-eval/tests/governance/contracts.spec.ts`
- Modify: `HANDOFF.md`

- [ ] Inspect the final resolver/evaluator/candidate-support diff and full import graph.
- [ ] Run the focused governance suite, package build, governance typecheck, and `git diff --check`.
- [ ] Run the full `packages/dsh-eval/tests` suite and record the existing sandbox-only CLI subprocess limitation if it remains.
- [ ] Request a read-only Sol review of the complete runtime slice and a scoped Luna review for any fix round.
- [ ] Commit only after review findings are resolved or explicitly recorded as future-scope rulings.

## Scope boundary

Proposal construction, approval/rejection/promotion/rollback transitions, and the hash-chained ledger are intentionally deferred to a separate implementation plan after this runtime slice proves authoritative resolution, evaluation replay, and candidate-support replay.
