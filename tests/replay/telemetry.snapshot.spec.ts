import { readdir } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { getValidatedCompleteRunsV1, parseDatasetV1 } from '../../packages/dsh-eval/src/telemetry/dataset.js'
import { buildCandidates } from '../../packages/dsh-eval/src/telemetry/candidates.js'
import { buildLessons } from '../../packages/dsh-eval/src/telemetry/lessons.js'
import { mineFailures } from '../../packages/dsh-eval/src/telemetry/miner.js'
import { fakeSpawnProvider } from '../../packages/dsh-orchestrator/tests/loader.spec.js'
import { annotation, ref } from '../../packages/dsh-eval/tests/telemetry/fixture.js'
import { economicalMultiAgentDag, parallelReplayEvents } from './economical-multi-agent.fixture.js'
import { validateParallelEventReplay } from './parallel-event-replay.js'
import {
  createRootSession,
  readTelemetrySegments,
  withControlAndTelemetryLoaders,
  withTelemetryLoader,
  withUnavailableTelemetryLoader,
} from './telemetry-loader.js'

const privateLegacy = {
  task: 'private-legacy-task-sentinel',
  summary: 'private-legacy-summary-sentinel',
  childSessionId: 'private-legacy-child-sentinel',
} as const

function comparableSessionEvents(snapshots: readonly (readonly unknown[])[]): unknown[][] {
  return snapshots.map(events => events.map(event => {
    if (typeof event !== 'object' || event === null || Array.isArray(event)) return event
    const copy = { ...(event as Record<string, unknown>) }
    delete copy.time
    return copy
  }))
}

describe('real Loader telemetry collection', () => {
  it('registers telemetry, collects three real Sessions, and preserves canonical session events', async () => {
    await withControlAndTelemetryLoaders(async ({ controlServices, storageRoot, services, telemetry }) => {
      const appendScenario = (target: typeof services) => {
        const sessions: { readonly session: { readonly events: unknown[] }; readonly initial: unknown[] }[] = []
        for (let index = 0; index < 3; index += 1) {
          const { session, detach } = createRootSession(target, `telemetry-root-${index}`)
          session.append('dsh-plugin/run-started', { schemaVersion: 1, mode: 'direct', provider: 'provider-disabled', model: 'baseline-disabled' } as any)
          session.append('dsh-plugin/budget-rejected', { schemaVersion: 1, reason: 'bounded-test', limit: 1, observed: 2 } as any)
          if (index === 0) {
            session.append('dsh-plugin/worker-requested', {
              schemaVersion: 1,
              task: privateLegacy.task,
              provider: 'provider-disabled',
              model: 'worker-disabled',
              maxTokens: 1,
              allowedTools: ['read_file'],
              expectedOutput: 'handoff-v1',
            } as any)
            session.append('dsh-plugin/worker-finished', {
              schemaVersion: 1,
              childSessionId: privateLegacy.childSessionId,
              handoff: {
                schemaVersion: 1,
                status: 'completed',
                summary: privateLegacy.summary,
                changedFiles: [],
                decisions: [],
                verification: [],
                blockers: [],
              },
            } as any)
          }
          sessions.push({ session, initial: structuredClone(session.events) })
          detach()
        }
        return sessions
      }

      const controlSessions = appendScenario(controlServices)
      const telemetrySessions = appendScenario(services)
      expect(comparableSessionEvents(telemetrySessions.map(item => item.initial))).toEqual(comparableSessionEvents(controlSessions.map(item => item.initial)))
      await telemetry.flush()
      expect(comparableSessionEvents(telemetrySessions.map(item => item.session.events))).toEqual(comparableSessionEvents(controlSessions.map(item => item.session.events)))
      const records = await readTelemetrySegments(storageRoot)
      const serialized = JSON.stringify(records)
      for (const value of Object.values(privateLegacy)) expect(serialized).not.toContain(value)
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'worker-requested', facts: { scope: 'worker' } }),
        expect.objectContaining({ kind: 'worker-finished', facts: { scope: 'worker', status: 'completed' } }),
      ]))
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
      expect(comparableSessionEvents(telemetrySessions.map(item => item.session.events))).toEqual(comparableSessionEvents(controlSessions.map(item => item.session.events)))
    })
  }, 30000)

  it('retains the actual scheduled root path without persisting raw routes', async () => {
    await withTelemetryLoader(async ({ runtime, storageRoot, services, telemetry }) => {
      const privateFallback = {
        provider: 'private-fallback-provider-sentinel',
        model: 'private-fallback-model-sentinel',
      }
      const { session, detach } = createRootSession(services, 'telemetry-scheduled-root')
      let selectedRoute: { provider: string; model: string } | undefined
      try {
        const result = await agentEvents(runtime.context as never, { id: session.id, session } as Agent).waterfall(
          'agent/request',
          { turn: 1, step: 1, signal: new AbortController().signal },
          async () => privateFallback,
        )
        session.append('request/header', { header: { config: result }, reason: 'initial' })
        await Promise.resolve()
        session.append('dsh-plugin/budget-rejected', { schemaVersion: 1, reason: 'private-task-prose-sentinel', limit: 1, observed: 2 } as any)
        expect(session.events.map((event: { type: string }) => event.type)).toEqual([
          'dsh-plugin/schedule-selected',
          'request/header',
          'dsh-plugin/run-started',
          'dsh-plugin/budget-rejected',
        ])
        const selected = session.events.find((event: { type: string }) => event.type === 'dsh-plugin/schedule-selected') as { data?: { provider?: unknown; model?: unknown } } | undefined
        if (typeof selected?.data?.provider !== 'string' || typeof selected.data.model !== 'string') {
          throw new Error('actual scheduled root did not retain its selected route')
        }
        selectedRoute = { provider: selected.data.provider, model: selected.data.model }
        expect(session.events).toEqual(expect.arrayContaining([
          expect.objectContaining({
            type: 'dsh-plugin/schedule-selected',
            data: expect.objectContaining(selectedRoute),
          }),
        ]))
      } finally {
        detach()
      }

      await telemetry.flush()
      const records = await readTelemetrySegments(storageRoot) as { kind: string; runRef: string; facts?: { scope?: string }; complete?: boolean; observationCount?: number; lostCount?: number }[]
      expect(records.map(record => record.kind)).toEqual([
        'schedule-selected',
        'run-started',
        'budget-rejected',
        'run-seal',
      ])
      expect(records[0]).toMatchObject({ facts: { scope: 'root' } })
      expect(records.at(-1)).toMatchObject({ observationCount: 3, lostCount: 0, complete: true })
      expect(new Set(records.map(record => record.runRef)).size).toBe(1)
      const serialized = JSON.stringify(records)
      if (selectedRoute === undefined) throw new Error('actual scheduled root route was not captured')
      for (const value of [...Object.values(selectedRoute), ...Object.values(privateFallback), 'private-task-prose-sentinel']) {
        expect(serialized).not.toContain(value)
      }
    })
  }, 30000)

  it('collects a complete economical parallel replay through the real Loader without persisting private prose', async () => {
    await withTelemetryLoader(async ({ runtime, storageRoot, services, telemetry }) => {
      const subagents = services.subagents
      if (subagents === undefined) throw new Error('parallel telemetry replay requires the Loader subagents service')
      const provider = fakeSpawnProvider()
      const privateEventProse: string[] = []
      let childNumber = 0
      let providerStarts = 0
      const unregister = subagents.registerProvider({
        ...provider,
        async start(request) {
          providerStarts += 1
          const started = await provider.start(request)
          return {
            ...started,
            id: SessionId(`telemetry-parallel-child-${++childNumber}`),
          }
        },
      })
      const { session, detach } = createRootSession(services, 'telemetry-parallel-root')
      let canonicalEvents: SessionEvent[] = []
      try {
        session.append('dsh-plugin/run-started', { schemaVersion: 1, mode: 'single-worker', provider: 'provider-disabled', model: 'parallel-disabled' } as any)
        const parent = { id: session.id, session }
        const parallel = (runtime.context as unknown as {
          get(name: string): { run(input: unknown): Promise<{ finalAggregate: unknown }> }
        }).get('parallelExecution')
        await parallel.run({ dag: economicalMultiAgentDag, parent, signal: new AbortController().signal })

        canonicalEvents = structuredClone(session.events) as SessionEvent[]
        for (const event of canonicalEvents as { type: string; data: unknown }[]) {
          const data = event.data as { task?: unknown; handoff?: { summary?: unknown } }
          if (event.type === 'dsh-plugin/worker-requested' && typeof data.task === 'string') privateEventProse.push(data.task)
          if (event.type === 'dsh-plugin/worker-finished' && typeof data.handoff?.summary === 'string') privateEventProse.push(data.handoff.summary)
        }
        expect(privateEventProse.length).toBeGreaterThan(0)
        const replay = validateParallelEventReplay(parallelReplayEvents(canonicalEvents) as SessionEvent[])
        expect(replay).toHaveLength(1)
        const [parallelReplay] = replay
        expect(parallelReplay.complete).toBe(true)
        expect(parallelReplay.committed).toBeDefined()
        if (parallelReplay.committed === undefined) throw new Error('parallel replay did not commit a final aggregate')
        expect(parallelReplay.committed.scope).toBe('dag')
        const committedNodeIds = parallelReplay.committed.nodeResults.map(result => result.nodeId).sort()
        const committedRequestIds = parallelReplay.committed.nodeResults.map(result => result.requestId).sort()
        expect(committedNodeIds).toEqual(economicalMultiAgentDag.nodes.map(node => node.nodeId).sort())
        expect(committedRequestIds).toEqual(economicalMultiAgentDag.nodes.map(node => `${parallelReplay.committed?.dagId}:node:${node.nodeId}`).sort())
      } finally {
        detach()
        unregister()
      }

      await telemetry.flush()
      const records = await readTelemetrySegments(storageRoot)
      const dataset = parseDatasetV1(records, [])
      const parallelStarted = dataset.records.filter(record => record.kind === 'parallel-started')
      expect(parallelStarted).toHaveLength(1)
      const parallelRunRef = parallelStarted[0]?.runRef
      expect(parallelRunRef).toEqual(expect.any(String))
      const fanoutRef = parallelStarted[0]?.facts.fanoutRef
      expect(fanoutRef).toEqual(expect.any(String))
      if (typeof parallelRunRef !== 'string' || typeof fanoutRef !== 'string') throw new Error('parallel replay projection did not retain its correlation identity')
      const parallelRecords = dataset.records.filter(record =>
        record.kind !== 'run-seal' &&
        ['parallel-started', 'parallel-finished', 'schedule-selected', 'worker-requested', 'worker-finished'].includes(record.kind) &&
        record.runRef === parallelRunRef && record.facts.fanoutRef !== undefined,
      )
      const parallelKinds = parallelRecords.map(record => record.kind)
      expect(parallelKinds.filter(kind => kind === 'parallel-started')).toHaveLength(1)
      expect(parallelKinds.filter(kind => kind === 'parallel-finished')).toHaveLength(1)
      expect(parallelKinds.filter(kind => kind === 'schedule-selected')).toHaveLength(economicalMultiAgentDag.nodes.length)
      expect(parallelKinds.filter(kind => kind === 'worker-requested')).toHaveLength(economicalMultiAgentDag.nodes.length)
      expect(parallelKinds.filter(kind => kind === 'worker-finished')).toHaveLength(economicalMultiAgentDag.nodes.length)
      expect(dataset.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'parallel-started', facts: expect.objectContaining({ scope: 'dag' }) }),
        expect.objectContaining({ kind: 'worker-requested', facts: expect.objectContaining({ scope: 'worker' }) }),
        expect.objectContaining({ kind: 'worker-finished', facts: expect.objectContaining({ scope: 'worker' }) }),
        expect.objectContaining({ kind: 'parallel-finished', facts: expect.objectContaining({ scope: 'dag' }) }),
      ]))
      const serialized = JSON.stringify(records)
      for (const node of economicalMultiAgentDag.nodes) expect(serialized).not.toContain(node.objective)
      for (const prose of privateEventProse) expect(serialized).not.toContain(prose)
      expect(providerStarts).toBe(economicalMultiAgentDag.nodes.length)
      expect(session.events).toEqual(canonicalEvents)
    }, { parallel: true })
  }, 30000)

  it('removes one Loader generation before a replacement writes with an independent run identity', async () => {
    await withTelemetryLoader(async ({ storageRoot, services, telemetry, removeTelemetry, reloadTelemetry }) => {
      const rootSessionId = 'telemetry-lifecycle-root'
      const first = createRootSession(services, rootSessionId)
      first.session.append('dsh-plugin/run-started', { schemaVersion: 1, mode: 'direct', provider: 'provider-disabled', model: 'lifecycle-disabled' } as any)
      first.session.append('dsh-plugin/budget-rejected', { schemaVersion: 1, reason: 'bounded-test', limit: 1, observed: 2 } as any)
      first.detach()
      await telemetry.flush()
      expect(await readdir(storageRoot)).toContain('writer.lock')

      const stale = createRootSession(services, rootSessionId)
      await removeTelemetry()
      expect(await readdir(storageRoot)).not.toContain('writer.lock')
      const afterRemoval = await readTelemetrySegments(storageRoot)

      stale.session.append('dsh-plugin/run-started', { schemaVersion: 1, mode: 'direct', provider: 'provider-disabled', model: 'stale-disabled' } as any)
      stale.session.append('dsh-plugin/budget-rejected', { schemaVersion: 1, reason: 'late-callback', limit: 1, observed: 2 } as any)
      stale.detach()
      await telemetry.flush()
      expect(await readTelemetrySegments(storageRoot)).toEqual(afterRemoval)

      const replacementTelemetry = await reloadTelemetry()
      const replacement = createRootSession(services, rootSessionId)
      replacement.session.append('dsh-plugin/run-started', { schemaVersion: 1, mode: 'direct', provider: 'provider-disabled', model: 'replacement-disabled' } as any)
      replacement.session.append('dsh-plugin/budget-rejected', { schemaVersion: 1, reason: 'bounded-test', limit: 1, observed: 2 } as any)
      replacement.detach()
      await replacementTelemetry.flush()

      const starts = (await readTelemetrySegments(storageRoot)).filter((record): record is { kind: string; runRef: string } =>
        typeof record === 'object' && record !== null && (record as { kind?: unknown }).kind === 'run-started')
      expect(starts).toHaveLength(2)
      expect(new Set(starts.map(record => record.runRef)).size).toBe(2)
    })
  }, 30000)

  it('yields zero candidates when one complete Loader run is exported or analyzed repeatedly', async () => {
    await withTelemetryLoader(async ({ storageRoot, services, telemetry }) => {
      const { session, detach } = createRootSession(services, 'telemetry-single-run')
      session.append('dsh-plugin/run-started', { schemaVersion: 1, mode: 'direct', provider: 'provider-disabled', model: 'single-run-disabled' } as any)
      session.append('dsh-plugin/budget-rejected', { schemaVersion: 1, reason: 'bounded-test', limit: 1, observed: 2 } as any)
      detach()
      await telemetry.flush()

      const records = await readTelemetrySegments(storageRoot)
      const failure = records.find((record): record is { domainRef: string; runRef: string; seq: number; kind: string } =>
        typeof record === 'object' && record !== null && (record as { kind?: unknown }).kind === 'budget-rejected')
      if (failure === undefined) throw new Error('Loader telemetry did not retain the bounded failure observation')
      const review = annotation(failure.runRef, {
        domainRef: failure.domainRef,
        outcome: 'failure',
        accepted: false,
        failure: { category: 'budget_exhaustion', attribution: 'observed', evidence: [{ runRef: failure.runRef, seq: failure.seq }] },
        evidence: [{ runRef: failure.runRef, seq: failure.seq }],
      })
      const analyze = (dataset: ReturnType<typeof parseDatasetV1>) =>
        buildCandidates(buildLessons(mineFailures(dataset)), dataset)
      const originalExport = parseDatasetV1(records, [review])
      expect(getValidatedCompleteRunsV1(originalExport)).toHaveLength(1)
      expect(analyze(originalExport)).toEqual([])

      const tripleExport = parseDatasetV1([...records, ...records, ...records], [review, review, review])
      expect(getValidatedCompleteRunsV1(tripleExport)).toHaveLength(1)
      expect(analyze(tripleExport)).toEqual([])
    })
  }, 30000)

  it('rejects corrupted Loader evidence and excludes a partial store from complete-run eligibility', async () => {
    await withTelemetryLoader(async ({ storageRoot, services, telemetry }) => {
      const { session, detach } = createRootSession(services, 'telemetry-negative-run')
      session.append('dsh-plugin/run-started', { schemaVersion: 1, mode: 'direct', provider: 'provider-disabled', model: 'negative-disabled' } as any)
      session.append('dsh-plugin/budget-rejected', { schemaVersion: 1, reason: 'bounded-test', limit: 1, observed: 2 } as any)
      detach()
      await telemetry.flush()

      const records = await readTelemetrySegments(storageRoot)
      const failure = records.find((record): record is { domainRef: string; runRef: string; seq: number; kind: string } =>
        typeof record === 'object' && record !== null && (record as { kind?: unknown }).kind === 'budget-rejected')
      if (failure === undefined) throw new Error('Loader telemetry did not retain the bounded failure observation')
      const invalidReview = annotation(failure.runRef, {
        domainRef: failure.domainRef,
        outcome: 'failure',
        accepted: false,
        failure: { category: 'budget_exhaustion', attribution: 'observed', evidence: [{ runRef: failure.runRef, seq: failure.seq + 100 }] },
        evidence: [{ runRef: failure.runRef, seq: failure.seq + 100 }],
      })
      expect(() => parseDatasetV1(records, [invalidReview])).toThrow(/evidence.*resolve/i)

      const validReview = annotation(failure.runRef, {
        domainRef: failure.domainRef,
        outcome: 'failure',
        accepted: false,
        failure: { category: 'budget_exhaustion', attribution: 'observed', evidence: [{ runRef: failure.runRef, seq: failure.seq }] },
        evidence: [{ runRef: failure.runRef, seq: failure.seq }],
      })
      const partial = parseDatasetV1(
        records.filter(record => (record as { kind?: unknown }).kind !== 'run-seal'),
        [validReview],
      )
      expect(getValidatedCompleteRunsV1(partial)).toEqual([])
      expect(buildCandidates(buildLessons(mineFailures(partial)), partial)).toEqual([])
    })
  }, 30000)

  it('keeps the keyless Loader outcome intact when telemetry storage is unavailable', async () => {
    await withUnavailableTelemetryLoader(async ({ runtime, storageRoot, services }) => {
      const subagents = services.subagents
      if (subagents === undefined) throw new Error('storage-failure acceptance requires the Loader subagents service')
      const provider = fakeSpawnProvider()
      let providerStarts = 0
      const unregister = subagents.registerProvider({
        ...provider,
        async start(request) {
          providerStarts += 1
          return provider.start(request)
        },
      })
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network invocation'))
      const privateInput = ['source-sentinel', 'prompt-sentinel', 'token-sentinel', 'private-sentinel'].join(':')
      try {
        const delegate = services.tools.get('delegate_worker') as {
          execute(input: unknown, exec: { signal: AbortSignal; agent: unknown; deferContext(value: unknown): void }): Promise<unknown>
        } | undefined
        if (delegate === undefined) throw new Error('actual Loader profile did not expose delegate_worker')
        const session = services.sessions.create(SessionId('telemetry-storage-failure-root'), { meta: { cwd: process.cwd() } })
        const contexts: unknown[] = []
        await expect(delegate.execute(
          { task: privateInput, allowedTools: ['targeted_verify'] },
          {
            signal: new AbortController().signal,
            agent: { id: SessionId('telemetry-storage-failure-root'), session },
            deferContext(value) { contexts.push(value) },
          },
        )).resolves.toMatchObject({ status: 'completed' })
        expect(contexts).toHaveLength(1)
        expect(providerStarts).toBe(1)
        expect(fetch).not.toHaveBeenCalled()
        expect((runtime.context as unknown as { get(name: string): unknown }).get('telemetry')).toBeUndefined()
        await expect(readdir(storageRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        fetch.mockRestore()
        unregister()
      }
    })
  }, 30000)
})
