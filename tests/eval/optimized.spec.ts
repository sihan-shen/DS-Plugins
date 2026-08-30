import { describe, expect, it } from 'vitest'
import { parseEvaluationRecordV1, type EvaluationTaskV1 } from '@ds-plugins/dsh-context'
import manifest from './fixtures/v0.2a/manifest.json'
import { runOptimized } from '../../packages/dsh-eval/src/optimized.js'

const tasks = manifest.tasks as EvaluationTaskV1[]
const conditions = ['cold', 'warm'] as const

describe('v0.2b optimized retrieval records', () => {
  it('emits exactly three cold and warm records for every fixed manifest task', async () => {
    const records = (await Promise.all(tasks.flatMap(task => conditions.flatMap(condition => [1, 2, 3].map(runIndex =>
      runOptimized(task, condition, runIndex as 1 | 2 | 3)))))).flat()

    expect(records).toHaveLength(72)
    for (const record of records) {
      expect(parseEvaluationRecordV1(record)).toEqual(record)
      expect(record.run_mode).toBe('optimized')
      expect(conditions).toContain(record.cache_condition)
      expect(record.cache_hits).toBe(0)
      expect(record.cache_misses).toBe(0)
      expect(record.uncached_source_tokens).toBe(record.source_token_estimate)
    }

    for (const task of tasks) {
      for (const condition of conditions) {
        expect(records.filter(record => record.task_id === task.task_id && record.cache_condition === condition).map(record => record.run_index)).toEqual([1, 2, 3])
      }
    }
  }, 30_000)

  it('fails closed before emitting a record for stale or missing fixture provenance', async () => {
    const task = tasks[0]
    await expect(runOptimized({ ...task, revision: 'stale-revision', verifier: { ...task.verifier, expected_revision: 'stale-revision' } }, 'cold', 1)).rejects.toThrow(/revision|stale|manifest|integrity/i)
    await expect(runOptimized({ ...task, baseline_paths: ['src/missing.ts'], target_symbols: [{ path: 'src/missing.ts', name: 'missing' }], verifier: { ...task.verifier, required_paths: ['src/missing.ts'] } }, 'cold', 1)).rejects.toThrow(/missing|read|fixture|path|snapshot|manifest/i)
  })
})
