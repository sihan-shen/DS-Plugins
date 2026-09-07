import type { ObservationV1 } from '@ds-plugins/dsh-telemetry/contracts'
import { canonicalGovernanceJson } from './canonical.js'
import { assertTemplateOfflineV1CorpusManifest } from './corpus.js'
import type {
  ArmMetricObservationV1,
  EvaluationArmV1,
  EvaluationEvidenceV1,
  EvaluationPairV1,
  EvaluationRunRefV1,
  MetricComparisonV1,
  OfflineEvidenceResolverInputV1,
  ResolvedRunEvidenceV1,
  TemplateArtifactV1,
} from './contracts.js'
import { TEMPLATE_OFFLINE_V1_POLICY_REF } from './policy.js'
import {
  validateEvaluationEvidenceV1,
  validateOfflineEvidenceResolverInputV1,
} from './validate.js'

const MAX_SAFE = Number.MAX_SAFE_INTEGER
const METRICS = ['task_success_rate', 'accepted_result_rate', 'verification_cost'] as const

type EvaluatorArmInput = {
  artifact: TemplateArtifactV1
  corpusRevision: '1'
  completeRuns: readonly ResolvedRunEvidenceV1[]
}

type EvaluatorOutput = {
  baseMetrics: ArmMetricObservationV1[]
  variantMetrics: ArmMetricObservationV1[]
  comparisons: MetricComparisonV1[]
}

function completeRun(run: ResolvedRunEvidenceV1): boolean {
  if (!run.seal || !run.annotation || !run.seal.complete || run.seal.lostCount !== 0) return false
  if (run.seal.observationCount !== run.observations.length) return false
  return run.observations.every((observation, index) => observation.seq === index + 1)
}

function deriveMetrics(runs: readonly ResolvedRunEvidenceV1[]): ArmMetricObservationV1[] {
  let known = 0
  let successes = 0
  let explicitAcceptance = 0
  let accepted = 0
  let cost = 0
  let costRuns = 0
  let overflow = false

  for (const run of runs) {
    const annotation = run.annotation!
    if (annotation.outcome !== 'unknown') {
      known += 1
      if (annotation.outcome === 'success') successes += 1
    }
    if (annotation.accepted !== null) {
      explicitAcceptance += 1
      if (annotation.accepted) accepted += 1
    }
    let hasDuration = false
    for (const observation of run.observations) {
      if (observation.kind === 'verification-finished' && observation.facts.durationMs !== undefined) {
        hasDuration = true
        if (cost > MAX_SAFE - observation.facts.durationMs) overflow = true
        else if (!overflow) cost += observation.facts.durationMs
      }
    }
    if (hasDuration) costRuns += 1
  }

  const rate = (
    name: typeof METRICS[0] | typeof METRICS[1],
    numerator: number,
    denominator: number,
  ): ArmMetricObservationV1 => denominator === 0
    ? { name, value: null, numerator: 0, denominator: 0, observedRuns: 0, eligibleRuns: runs.length, basis: 'unavailable' }
    : { name, value: numerator / denominator, numerator, denominator, observedRuns: denominator, eligibleRuns: runs.length, basis: 'observed' }

  const verificationCost: ArmMetricObservationV1 = overflow
    ? { name: 'verification_cost', value: null, numerator: 0, denominator: 0, observedRuns: 0, eligibleRuns: 0, basis: 'unavailable' }
    : costRuns === 0
      ? { name: 'verification_cost', value: null, numerator: 0, denominator: 0, observedRuns: 0, eligibleRuns: runs.length, basis: 'unavailable' }
      : { name: 'verification_cost', value: cost / costRuns, numerator: cost, denominator: costRuns, observedRuns: costRuns, eligibleRuns: runs.length, basis: 'observed' }

  return [
    rate('task_success_rate', successes, known),
    rate('accepted_result_rate', accepted, explicitAcceptance),
    verificationCost,
  ]
}

function evaluateArms(base: EvaluatorArmInput, variant: EvaluatorArmInput): EvaluatorOutput {
  const baseMetrics = deriveMetrics(base.completeRuns)
  const variantMetrics = deriveMetrics(variant.completeRuns)
  const minimumCoverage = (name: typeof METRICS[number]): number => name === 'verification_cost' ? 0.8 : 1
  const available = (metric: ArmMetricObservationV1, name: typeof METRICS[number]): boolean => (
    metric.value !== null
    && metric.basis === 'observed'
    && metric.eligibleRuns > 0
    && metric.observedRuns / metric.eligibleRuns >= minimumCoverage(name)
  )
  const comparisons = METRICS.map((name, index): MetricComparisonV1 => {
    const baseMetric = baseMetrics[index]!
    const variantMetric = variantMetrics[index]!
    if (!available(baseMetric, name) || !available(variantMetric, name)) {
      return { name, baseValue: null, variantValue: null, delta: null, result: 'unavailable' }
    }
    const baseValue = baseMetric.value!
    const variantValue = variantMetric.value!
    const delta = variantValue - baseValue
    const passed = name === 'verification_cost'
      ? variantValue <= baseValue * 1.1
      : delta >= 0
    return { name, baseValue, variantValue, delta, result: passed ? 'pass' : 'fail' }
  })
  return { baseMetrics, variantMetrics, comparisons }
}

function runRef(run: ResolvedRunEvidenceV1): EvaluationRunRefV1 {
  return run.ref
}

function buildArm(
  artifact: TemplateArtifactV1,
  fixtureCount: number,
  runs: readonly ResolvedRunEvidenceV1[],
  metrics: ArmMetricObservationV1[],
): EvaluationArmV1 {
  const completeRuns = runs.filter(completeRun)
  return {
    artifact,
    corpusRevision: '1',
    runs: runs.map(runRef),
    fixtureRuns: fixtureCount,
    resolvedRuns: runs.length,
    completeRuns: completeRuns.length,
    incompleteRuns: fixtureCount - completeRuns.length,
    excludedRuns: 0,
    metrics,
  }
}

export function resolveOfflineEvidence(input: OfflineEvidenceResolverInputV1): EvaluationEvidenceV1 {
  const admitted = validateOfflineEvidenceResolverInputV1(input)
  const corpusManifest = assertTemplateOfflineV1CorpusManifest(admitted.corpusManifest)
  const fixtureCount = corpusManifest.fixtures.length
  const baseCompleteRuns = admitted.baseRuns.filter(completeRun)
  const variantCompleteRuns = admitted.variantRuns.filter(completeRun)
  const evaluated = evaluateArms(
    { artifact: admitted.baseArtifact, corpusRevision: '1', completeRuns: baseCompleteRuns },
    { artifact: admitted.variantArtifact, corpusRevision: '1', completeRuns: variantCompleteRuns },
  )
  const baseArm = buildArm(admitted.baseArtifact, fixtureCount, admitted.baseRuns, evaluated.baseMetrics)
  const variantArm = buildArm(admitted.variantArtifact, fixtureCount, admitted.variantRuns, evaluated.variantMetrics)
  const baseByTuple = new Map(baseCompleteRuns.map(run => [tupleKey(run.ref), run.ref]))
  const variantByTuple = new Map(variantCompleteRuns.map(run => [tupleKey(run.ref), run.ref]))
  const pairs: EvaluationPairV1[] = corpusManifest.fixtures.flatMap(fixture => {
    const baseRun = baseByTuple.get(tupleKey(fixture))
    const variantRun = variantByTuple.get(tupleKey(fixture))
    return baseRun && variantRun
      ? [{ fixtureId: fixture.fixtureId, fixtureRevision: fixture.fixtureRevision, pairingKey: fixture.pairingKey, baseRun, variantRun }]
      : []
  })
  const result: EvaluationEvidenceV1['result'] = evaluated.comparisons.some(item => item.result === 'fail')
    ? 'failed'
    : pairs.length !== fixtureCount || baseArm.completeRuns !== fixtureCount || variantArm.completeRuns !== fixtureCount
      || evaluated.comparisons.slice(0, 2).some(item => item.result === 'unavailable')
      ? 'incomplete'
      : 'passed'
  const evidence: EvaluationEvidenceV1 = {
    schemaVersion: 1,
    policy: { ...TEMPLATE_OFFLINE_V1_POLICY_REF },
    corpusId: corpusManifest.corpusId,
    corpusRevision: corpusManifest.corpusRevision,
    corpusManifestDigest: corpusManifest.corpusManifestDigest,
    resolverInput: admitted,
    baseArm,
    variantArm,
    pairs,
    comparisons: evaluated.comparisons,
    result,
  }
  const resolved = validateEvaluationEvidenceV1(evidence)
  if (canonicalGovernanceJson(resolved.policy) !== canonicalGovernanceJson(TEMPLATE_OFFLINE_V1_POLICY_REF)
    || resolved.corpusManifestDigest !== corpusManifest.corpusManifestDigest) {
    throw new TypeError('governance resolver evaluator identity mismatch')
  }
  return resolved
}

function tupleKey(value: { fixtureId: string, fixtureRevision: string, pairingKey: string }): string {
  return `${value.fixtureId}\u0000${value.fixtureRevision}\u0000${value.pairingKey}`
}
