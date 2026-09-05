import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { validateParallelEventReplay, ParallelReplayCorruptionError } from './parallel-event-replay.ts'
import { economicalMultiAgentDag, parallelReplayEvents } from './economical-multi-agent.fixture.ts'
import { fakeSpawnProvider, injectedServices, loadActualProfile } from '../../packages/dsh-orchestrator/tests/loader.spec.ts'

const t = { fanoutId: 'dag-1:aggregate', nodeId: 'worker-a', requestId: 'dag-1:node:worker-a' } as const
const manifest = { schemaVersion: 1, dagId: 'dag-1', requests: [t] }
const worker = { schemaVersion: 1, task: 'do work', provider: 'p', model: 'm', maxTokens: 1, allowedTools: ['read_file'], expectedOutput: 'handoff-v1', ...t }
const handoff = { schemaVersion: 1, status: 'completed', summary: 'done', changedFiles: [], decisions: [], verification: [], blockers: [] }
const finished = { schemaVersion: 1, workerRef: `w:${'a'.repeat(32)}`, handoff, ...t }
const aggregate = { schemaVersion: 1, dagId: 'dag-1', scope: 'dag', fanoutId: 'dag-1:aggregate', nodeResults: [{ schemaVersion: 1, nodeId: t.nodeId, requestId: t.requestId, workerRef: finished.workerRef, status: 'completed', reason: 'completed' }], aggregateStatus: 'completed', verificationOutcome: 'not-run-no-commands', ownershipViolations: [], projectedHandoff: handoff }
const event = (type: string, data: unknown): SessionEvent => ({ type, data } as SessionEvent)
const start = event('dsh-plugin/parallel-started', manifest)
const selected = event('dsh-plugin/schedule-selected', { schemaVersion: 1, target: 'worker', source: 'scheduler', provider: 'p', model: 'm', maxTokens: 1, ...t })
const requested = event('dsh-plugin/worker-requested', worker)
const done = event('dsh-plugin/worker-finished', finished)
const committed = event('dsh-plugin/parallel-finished', aggregate)

describe('v0.4 parallel durable replay', () => {
  it('runs an economical DAG through the real Loader Session with parallel children and adaptive tools', async () => {
    await loadActualProfile({ profile: 'v0.3-adaptive', mode: 'single-worker', enableSubagents: true, parallelOverlay: true }).then(async runtime => {
      try {
        const services = await injectedServices(runtime.context, true)
        const requests: unknown[] = []
        let active = 0
        let maxActive = 0
        let childNumber = 0
        const unregister = services.subagents!.registerProvider({
          ...fakeSpawnProvider(),
          async start(request) {
            requests.push(request)
            active += 1
            maxActive = Math.max(maxActive, active)
            await new Promise(resolve => setTimeout(resolve, 5))
            active -= 1
            return {
              id: SessionId(`loader-economical-child-${++childNumber}`),
              localAgent: undefined,
              result: Promise.resolve({ stopReason: 'completed' as const, output: [], structured: { schemaVersion: 1, status: 'completed', summary: 'ok', changedFiles: [], decisions: [], verification: [], blockers: [] } }),
              dispose: async () => undefined,
            }
          },
        })
        try {
          const parentSession = services.sessions.create(SessionId('loader-economical-root'), { meta: { cwd: process.cwd() } })
          const parent = { id: (parentSession as { id: ReturnType<typeof SessionId> }).id, session: parentSession }
          const service = (runtime.context as unknown as { get(name: string): { run(input: unknown): Promise<{ finalAggregate: unknown }> } }).get('parallelExecution')
          const resultPromise = service.run({ dag: economicalMultiAgentDag, parent, signal: new AbortController().signal })
          const result = await resultPromise
          expect(requests).toHaveLength(2)
          expect(maxActive).toBe(2)
          const childDepths = requests.map(request => (request as { maxDepth: number }).maxDepth)
          expect(childDepths).toEqual([1, 1])
          expect(childDepths.every(depth => depth > 0)).toBe(true)
          const childToolFilters = requests.map(request => (request as { toolFilter: { allow: string[] } }).toolFilter.allow)
          expect(childToolFilters).toEqual([['read_file'], ['read_file']])
          expect(childToolFilters.every(filter => filter.length > 0)).toBe(true)
          const sessionEvents = (parentSession as { events: { type: string; data: unknown }[] }).events
          const events = parallelReplayEvents(sessionEvents)
          expect(result.finalAggregate).toMatchObject({
            aggregateStatus: 'completed',
            verificationOutcome: 'passed',
            verification: [{ commandName: 'test:profile', status: 'passed', exitCode: 0 }],
            nodeResults: [{ status: 'completed' }, { status: 'completed' }],
          })
          expect(events.length).toBeGreaterThan(0)
          expect(validateParallelEventReplay(events as SessionEvent[])).toMatchObject([{ complete: true }])
          expect(events.filter(event => event.type === 'dsh-plugin/parallel-started')).toHaveLength(1)
          expect(events.filter(event => event.type === 'dsh-plugin/parallel-finished')).toHaveLength(1)
          expect(sessionEvents.filter(event => event.type === 'dsh-plugin/verification-finished')).toMatchObject([
            { data: { commandName: 'test:profile', status: 'passed', exitCode: 0 } },
          ])
        } finally { unregister() }
      } finally { await runtime.dispose() }
    })
  })
  it('preserves legacy-only and interleaved unrelated records', () => {
    expect(validateParallelEventReplay([event('dsh-plugin/run-started', {})])).toEqual([])
    expect(validateParallelEventReplay([event('dsh-plugin/run-started', {}), start, selected, requested, done, event('dsh-plugin/verification-finished', {}), committed])).toMatchObject([{ complete: true }])
  })

  it.each([[start], [start, selected], [start, selected, requested], [start, selected, requested, done]])('accepts suffix-truncated interrupted prefixes', (...events) => {
    expect(validateParallelEventReplay(events as SessionEvent[])).toMatchObject([{ complete: false }])
  })

  it.each([
    [event('dsh-plugin/worker-requested', worker)],
    [start, event('dsh-plugin/worker-requested', worker)],
    [start, event('dsh-plugin/worker-finished', finished)],
    [start, selected, requested, requested],
    [start, selected, requested, done, committed, committed],
  ])('rejects malformed parallel prefixes', (...events) => {
    expect(() => validateParallelEventReplay(events as SessionEvent[])).toThrowError(ParallelReplayCorruptionError)
  })

  it('rejects a final aggregate that omits a manifest node', () => {
    const bad = { ...aggregate, nodeResults: [] }
    expect(() => validateParallelEventReplay([start, selected, requested, done, event('dsh-plugin/parallel-finished', bad)])).toThrowError(ParallelReplayCorruptionError)
  })

  it('rejects incomplete correlation and correlated events after commit', () => {
    expect(() => validateParallelEventReplay([start, event('dsh-plugin/schedule-selected', { ...selected.data, nodeId: undefined })])).toThrowError(ParallelReplayCorruptionError)
    expect(() => validateParallelEventReplay([start, selected, requested, done, committed, selected])).toThrowError(ParallelReplayCorruptionError)
    const legacy = event('dsh-plugin/worker-finished', { schemaVersion: 1, childSessionId: 'legacy-child', handoff })
    expect(validateParallelEventReplay([legacy])).toEqual([])
    expect(() => validateParallelEventReplay([event('dsh-plugin/worker-finished', { ...finished, nodeId: undefined })])).toThrowError(ParallelReplayCorruptionError)
  })

  it('accepts the actual level fanout grammar', () => {
    const levelTriple = { ...t, fanoutId: 'dag-1:level:0' }
    const levelManifest = event('dsh-plugin/parallel-started', { ...manifest, requests: [levelTriple] })
    const levelAggregate = { ...aggregate, fanoutId: 'dag-1:level:0', scope: 'level', levelId: 'dag-1:level:0', levelIndex: 0, nodeResults: aggregate.nodeResults.map(result => ({ ...result, nodeId: levelTriple.nodeId, requestId: levelTriple.requestId })) }
    const finalAggregate = { ...aggregate, nodeResults: aggregate.nodeResults.map(result => ({ ...result, nodeId: levelTriple.nodeId, requestId: levelTriple.requestId })) }
    const events = [levelManifest, event('dsh-plugin/schedule-selected', { ...selected.data, ...levelTriple }), event('dsh-plugin/worker-requested', { ...worker, ...levelTriple }), event('dsh-plugin/worker-finished', { ...finished, ...levelTriple }), event('dsh-plugin/parallel-finished', levelAggregate), event('dsh-plugin/parallel-finished', finalAggregate)]
    expect(validateParallelEventReplay(events)).toMatchObject([{ complete: true, levelAggregates: [{ levelIndex: 0 }] }])
    expect(() => validateParallelEventReplay([...events.slice(0, 5), event('dsh-plugin/parallel-finished', levelAggregate)])).toThrowError(ParallelReplayCorruptionError)
  })

  it('rejects a terminal result whose workerRef does not match parsed worker evidence', () => {
    const bad = { ...aggregate, nodeResults: aggregate.nodeResults.map(result => ({ ...result, workerRef: `w:${'b'.repeat(32)}` })) }
    expect(() => validateParallelEventReplay([start, selected, requested, done, event('dsh-plugin/parallel-finished', bad)])).toThrowError(ParallelReplayCorruptionError)
  })

  it('rejects a zero-executable level aggregate', () => {
    const levelTriple = { ...t, fanoutId: 'dag-1:level:0' }
    const levelManifest = event('dsh-plugin/parallel-started', { ...manifest, requests: [levelTriple] })
    const result = { schemaVersion: 1, nodeId: levelTriple.nodeId, requestId: levelTriple.requestId, status: 'not-run', reason: 'zero-worker-constraint' }
    const levelAggregate = { ...aggregate, fanoutId: levelTriple.fanoutId, scope: 'level', levelId: levelTriple.fanoutId, levelIndex: 0, nodeResults: [result], aggregateStatus: 'blocked', verificationOutcome: 'not-run-no-accepted-nodes' }
    const finalAggregate = { ...aggregate, nodeResults: [result], aggregateStatus: 'blocked', verificationOutcome: 'not-run-no-accepted-nodes' }
    expect(() => validateParallelEventReplay([levelManifest, event('dsh-plugin/parallel-finished', levelAggregate), event('dsh-plugin/parallel-finished', finalAggregate)])).toThrowError(ParallelReplayCorruptionError)
  })

  it('rejects a level aggregate made entirely of admission-rejected outcomes', () => {
    const levelTriple = { ...t, fanoutId: 'dag-1:level:0' }
    const levelManifest = event('dsh-plugin/parallel-started', { ...manifest, requests: [levelTriple] })
    const result = { schemaVersion: 1, nodeId: levelTriple.nodeId, requestId: levelTriple.requestId, status: 'not-run', reason: 'admission-rejected' }
    const levelAggregate = { ...aggregate, fanoutId: levelTriple.fanoutId, scope: 'level', levelId: levelTriple.fanoutId, levelIndex: 0, nodeResults: [result], aggregateStatus: 'blocked', verificationOutcome: 'not-run-no-commands' }
    expect(() => validateParallelEventReplay([levelManifest, event('dsh-plugin/parallel-finished', levelAggregate)])).toThrowError(ParallelReplayCorruptionError)
  })

  it.each([
    ['no-route', 'not-run'],
    ['tool-unauthorized', 'not-run'],
    ['admission-rejected', 'not-run'],
    ['cancelled-before-start', 'not-run'],
    ['start-failed', 'failed'],
    ['handoff-payload-too-large', 'failed'],
  ] as const)('enforces exact worker cardinality for %s', (reason, status) => {
    const result = { schemaVersion: 1, nodeId: t.nodeId, requestId: t.requestId, status, reason, ...(status === 'failed' && reason === 'handoff-payload-too-large' ? { workerRef: finished.workerRef } : {}) }
    const valid = { ...aggregate, nodeResults: [result], aggregateStatus: status === 'not-run' ? 'blocked' : 'failed' }
    expect(validateParallelEventReplay([start, ...(status === 'not-run' && reason !== 'start-failed' && reason !== 'cancelled-before-start' ? [] : [selected, requested, ...(status === 'failed' && reason === 'failed-result' ? [done] : [])]), event('dsh-plugin/parallel-finished', valid)])).toMatchObject([{ complete: true }])

    if (status === 'not-run' && (reason === 'no-route' || reason === 'tool-unauthorized')) {
      expect(() => validateParallelEventReplay([start, selected, requested, event('dsh-plugin/parallel-finished', valid)])).toThrowError(ParallelReplayCorruptionError)
    }
  })

  it('allows final-only nodes from skipped levels and folds the last actual verification invocation', () => {
    const first = { ...t, fanoutId: 'dag-1:level:0' }
    const skipped = { ...t, nodeId: 'worker-b', requestId: 'dag-1:node:worker-b', fanoutId: 'dag-1:level:1' }
    const levelManifest = event('dsh-plugin/parallel-started', { ...manifest, requests: [first, skipped] })
    const firstResult = { ...aggregate.nodeResults[0], nodeId: first.nodeId, requestId: first.requestId }
    const skippedResult = { schemaVersion: 1, nodeId: skipped.nodeId, requestId: skipped.requestId, status: 'not-run', reason: 'level-verification-stopped' as const }
    const levelAggregate = { ...aggregate, scope: 'level' as const, fanoutId: first.fanoutId, levelId: first.fanoutId, levelIndex: 0, nodeResults: [firstResult] }
    const finalAggregate = { ...aggregate, nodeResults: [firstResult, skippedResult], aggregateStatus: 'blocked' as const }
    expect(validateParallelEventReplay([levelManifest, event('dsh-plugin/schedule-selected', { ...selected.data, ...first }), event('dsh-plugin/worker-requested', { ...requested.data, ...first }), event('dsh-plugin/worker-finished', { ...done.data, ...first }), event('dsh-plugin/parallel-finished', levelAggregate), event('dsh-plugin/parallel-finished', finalAggregate)])).toMatchObject([{ complete: true }])
  })
})
