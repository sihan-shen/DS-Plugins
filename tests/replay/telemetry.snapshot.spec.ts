import { describe, expect, it } from 'vitest'
import { parseDatasetV1 } from '../../packages/dsh-eval/src/telemetry/dataset.js'
import { buildCandidates } from '../../packages/dsh-eval/src/telemetry/candidates.js'
import { buildLessons } from '../../packages/dsh-eval/src/telemetry/lessons.js'
import { mineFailures } from '../../packages/dsh-eval/src/telemetry/miner.js'
import { annotation, observation, ref, seal } from '../../packages/dsh-eval/tests/telemetry/fixture.js'
import { createRootSession, readTelemetrySegments, withTelemetryLoader } from './telemetry-loader.js'

describe('real Loader telemetry collection', () => {
  it('registers telemetry, collects three real Sessions, and preserves canonical session events', async () => {
    await withTelemetryLoader(async ({ storageRoot, services, telemetry }) => {
      const before: unknown[][] = []
      for (let index = 0; index < 3; index += 1) {
        const { session, detach } = createRootSession(services, `telemetry-root-${index}`)
        const snapshot = () => structuredClone(session.events)
        session.append('dsh-plugin/run-started', { schemaVersion: 1, mode: 'direct', provider: 'provider-disabled', model: 'baseline-disabled' } as any)
        session.append('dsh-plugin/budget-rejected', { schemaVersion: 1, reason: 'bounded-test', limit: 1, observed: 2 } as any)
        before.push(snapshot())
        const after = snapshot()
        expect(after).toEqual(before[index])
        detach()
      }
      await telemetry.flush()
      const records = await readTelemetrySegments(storageRoot)
      expect(JSON.stringify(records)).not.toContain('private-prompt-sentinel')
      const runs = records.filter((record): record is { domainRef: string; runRef: string; kind: string } =>
        typeof record === 'object' && record !== null && (record as any).kind === 'run-started')
      const annotations = runs.map((run, index) => annotation(run.runRef, {
        domainRef: run.domainRef, runRef: run.runRef,
        taskInstanceRef: index === 2 ? ref('9') : ref('8'),
        outcome: 'failure', accepted: false,
        failure: { category: 'budget_exhaustion', attribution: 'observed', evidence: [{ runRef: run.runRef, seq: 2 }] },
        evidence: [{ runRef: run.runRef, seq: 2 }],
      }))
      const dataset = parseDatasetV1(records, annotations)
      const candidates = buildCandidates(buildLessons(mineFailures(dataset)), dataset)
      expect(candidates.length).toBeGreaterThan(0)
      for (const candidate of candidates) for (const evidence of candidate.evidence) {
        expect(dataset.records.some(record => record.kind !== 'run-seal' && record.runRef === evidence.runRef && record.seq === evidence.seq)).toBe(true)
      }
    })
  }, 30000)

  it('does not produce a policy candidate from one complete run', () => {
    const runRef = ref('a')
    const dataset = parseDatasetV1(
      [observation(runRef, 1, 'budget-rejected'), seal(runRef, 1)],
      [annotation(runRef, {
        outcome: 'failure', accepted: false,
        failure: { category: 'budget_exhaustion', attribution: 'observed', evidence: [{ runRef, seq: 1 }] },
        evidence: [{ runRef, seq: 1 }],
      })],
    )
    expect(buildCandidates(buildLessons(mineFailures(dataset)), dataset)).toEqual([])
  })
})
