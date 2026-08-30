import { describe, expect, it } from 'vitest'
import { parseEvaluationRecordV1, parsePromotionReportV1, type EvaluationRecordV1, type EvaluationTaskV1 } from '@ds-plugins/dsh-context'
import manifest from './fixtures/v0.2a/manifest.json'
import { runBaselineThreeTimes } from '../../packages/dsh-eval/src/baseline.js'
import { runFixtureVerifier } from '../../packages/dsh-eval/src/fixture-verifier.js'
import { computeRetrievalMetrics } from '../../packages/dsh-eval/src/metrics.js'
import { evaluatePromotion } from '../../packages/dsh-eval/src/reports.js'
import { runOptimized } from '../../packages/dsh-eval/src/optimized.js'

const tasks = manifest.tasks as EvaluationTaskV1[]

async function corpusRecords(): Promise<EvaluationRecordV1[]> {
  const records: EvaluationRecordV1[] = []
  for (const task of tasks) {
    for (const baseline of await runBaselineThreeTimes(task)) {
      records.push(computeRetrievalMetrics({ ...baseline, verifier_result: await runFixtureVerifier(task, baseline) }))
    }
    for (const condition of ['cold', 'warm'] as const) {
      for (const runIndex of [1, 2, 3] as const) records.push(await runOptimized(task, condition, runIndex))
    }
  }
  return records
}

describe('v0.2b optimized promotion gate', () => {
  it('passes the complete twelve-task corpus at the v0.2a thresholds', async () => {
    const records = await corpusRecords()
    const report = evaluatePromotion(records)
    expect(report).toMatchObject({ task_count: 12, repository_shape_count: 3, passes: true, status: 'passed' })
    expect(report.aggregates.cold?.median_source_token_reduction).toBeGreaterThanOrEqual(0.25)
    expect(report.aggregates.warm?.median_source_token_reduction).toBeGreaterThanOrEqual(0.25)
    expect(report.aggregates.cold?.mean_symbol_query_recall_at_5).toBeGreaterThanOrEqual(0.95)
    expect(report.aggregates.cold?.mean_target_coverage).toBeGreaterThanOrEqual(0.95)
    expect(report.aggregates.cold?.mean_oracle_success).toBeGreaterThanOrEqual(0.95)
    expect(parsePromotionReportV1(report)).toEqual(report)
  }, 30_000)

  it('rejects duplicate, missing, stale, forged, and incomplete records', async () => {
    const records = await corpusRecords()
    expect(evaluatePromotion([...records, records[0]!])).toMatchObject({ status: 'failed', failure_class: 'invalid_pairing' })
    expect(evaluatePromotion(records.slice(0, -1))).toMatchObject({ status: 'failed', failure_class: 'invalid_pairing' })
    expect(evaluatePromotion(records.map((record, index) => index === 0 ? { ...record, task_id: 'stale-task' } : record))).toMatchObject({ status: 'failed', failure_class: 'invalid_pairing' })
    expect(() => evaluatePromotion(records.map((record, index) => index === 1 ? { ...record, oracle_success: true, verification_status: 'failed' } : record))).toThrow(/oracle|verification/i)
    const incompleteBaseline = records.filter((record, index) => !(index === 0 && record.run_mode === 'baseline'))
    expect(evaluatePromotion(incompleteBaseline)).toMatchObject({ status: 'failed', failure_class: 'invalid_pairing' })
  }, 30_000)
})
