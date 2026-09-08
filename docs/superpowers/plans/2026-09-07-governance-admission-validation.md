# Governance Admission and Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first runtime v0.6 slice that accepts only bounded, canonical governance input and validates the exported governance contracts without mutating caller data.

**Architecture:** Keep admission and validation inside the pure `@han_05/dsh-eval/governance` subpath. Separate raw-byte canonical admission from detached object validation so raw APIs can compare original bytes while object APIs can validate and serialize without claiming raw provenance. Reuse the existing governance canonicalizer only after making its byte, depth, node, field, string, and error limits explicit.

**Tech Stack:** TypeScript, Node `TextDecoder`/`TextEncoder`, Vitest, existing governance contracts, existing `node:crypto` hashing.

**Spec:** `docs/superpowers/specs/2026-09-06-dsh-v0.6-offline-governance-design.md`

## Global Constraints

- Governance remains pure and in-memory; no filesystem, provider, network, profile, routing, permission, or credential access.
- Raw input must be decoded with fatal UTF-8, reject BOM/trailing content/non-canonical bytes, and enforce the 16 MiB document cap before unbounded work.
- Object input must reject cycles, non-plain values, accessors, non-enumerable fields, symbols, sparse/named arrays, unsupported values, non-finite numbers, and negative zero without invoking getters or `toJSON`.
- Enforce depth 32, 1,048,576 value nodes, 32 own fields per object, 128 UTF-8 bytes per key/string, and bounded canonical output/error sizes.
- Unknown keys, malformed references, inconsistent derived values, and caller mutations fail closed.
- Keep the built governance import graph limited to local governance modules, `node:crypto`, and the telemetry contracts needed by types.

### Task 1: Raw Canonical Admission

**Files:**
- Create: `packages/dsh-eval/src/governance/admission.ts`
- Modify: `packages/dsh-eval/src/governance/canonical.ts`
- Modify: `packages/dsh-eval/src/governance/index.ts`
- Test: `packages/dsh-eval/tests/governance/admission.spec.ts`

**Interfaces:**
- Produce `parseCanonicalGovernanceJson(input: Uint8Array): unknown`, which returns one validated JSON value only when the original bytes equal the canonical UTF-8 serialization.
- Produce `canonicalGovernanceJson(value: unknown): string` for validated detached object inputs.
- Keep `sha256Canonical(value: unknown): string` as the public digest helper over the canonical bytes.

- [ ] Write failing tests for fatal UTF-8, BOM, whitespace/newline, trailing bytes, duplicate keys, alternate number/string spellings, lone surrogates, and exact canonical bytes.
- [ ] Run the focused admission tests and confirm they fail for missing exports/behavior.
- [ ] Implement bounded byte decoding, one-value parsing, strict detached validation, and byte-for-byte canonical comparison with fixed bounded errors.
- [ ] Run admission tests, governance typecheck, and governance purity tests.
- [ ] Commit as `feat(dsh-eval): add governance canonical admission`.

### Task 2: Contract Shape Validators

**Files:**
- Create: `packages/dsh-eval/src/governance/validate.ts`
- Modify: `packages/dsh-eval/src/governance/index.ts`
- Test: `packages/dsh-eval/tests/governance/validate.spec.ts`

**Interfaces:**
- Produce strict validators for artifact refs, template artifacts, corpus fixtures/manifests, run refs, evaluation arms/pairs, resolver inputs, candidate support, proposals, decisions, entries, and ledgers.
- Validators return detached validated snapshots or throw bounded fixed-code errors; they never repair, sort, truncate, or mutate caller data.

- [ ] Add failing fixtures for exact keys, literal versions, lowercase hashes, ordering, uniqueness, bounds, and derived-field consistency.
- [ ] Run focused validator tests and confirm the new cases fail before implementation.
- [ ] Implement validators in dependency order from leaf refs through resolver/proposal/ledger containers.
- [ ] Verify caller mutation cannot alter returned snapshots or previously validated values.
- [ ] Run focused tests, typecheck, build, and purity checks.
- [ ] Commit as `feat(dsh-eval): validate governance contract shapes`.

### Task 3: Frozen Policy and Corpus Inputs

**Files:**
- Create: `packages/dsh-eval/src/governance/policy.ts`
- Create: `packages/dsh-eval/src/governance/corpus.ts`
- Modify: `packages/dsh-eval/src/governance/index.ts`
- Test: `packages/dsh-eval/tests/governance/policy-corpus.spec.ts`

**Interfaces:**
- Export immutable in-memory revision-1 policy and `template-offline-v1-corpus` manifest constants plus their canonical bytes/digests.
- Expose no filesystem or runtime evaluator dependency.

- [ ] Add golden digest tests and rejection tests for substituted, reordered, missing, duplicate, or stale manifest records.
- [ ] Implement frozen constants and digest derivation from the canonical bodies.
- [ ] Verify deep caller mutation cannot alter exported constants.
- [ ] Run policy/corpus tests and the full governance-focused suite.
- [ ] Commit as `feat(dsh-eval): add frozen governance policy and corpus`.

### Task 4: Runtime Slice Review

**Files:**
- Modify: `packages/dsh-eval/tests/governance/contracts.spec.ts`
- Modify: `docs/superpowers/HANDOFF.md` if continuation state is needed

- [ ] Inspect the final diff and import graph.
- [ ] Run the focused governance suite, package build, governance typecheck, and `git diff --check`.
- [ ] Run the full package suite; record the existing sandbox-only CLI subprocess limitation separately.
- [ ] Request a read-only code review before starting resolver/evaluator work.
- [ ] Commit only after all required checks are fresh and passing.
