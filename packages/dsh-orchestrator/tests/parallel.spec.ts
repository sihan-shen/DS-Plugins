import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRun, SubagentRuntime, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import {
  parseTaskDagV1,
  type TaskDagV1,
  type TaskNodeV1,
} from '@ds-plugins/dsh-scheduling-contracts'
import { createBudgetControllerRegistry } from '../src/budgets.ts'
import { appendParallelStarted } from '../src/parallel-events.ts'
import {
  allocateDagId,
  createParallelExecutionRuntime,
  type ParallelRunValidationError,
} from '../src/parallel.ts'
import type { SchedulerResolver } from '../src/scheduling.ts'
import type { HandoffV1, OrchestratorConfig } from '../src/types.ts'

const profile = {
  coding: 70,
  reasoning: 70,
  toolUse: 50,
  repoContext: 60,
  risk: 30,
  difficulty: 50,
} as const

interface NodeInput {
  readonly id: string
  readonly dependsOn?: readonly string[]
  readonly noRoute?: boolean
  readonly maxWorkers?: number
}

function dag(nodes: readonly NodeInput[]): TaskDagV1 {
  return parseTaskDagV1({
    schemaVersion: 1,
    rootTaskId: 'task-11-root',
    nodes: nodes.map((input): TaskNodeV1 => ({
      schemaVersion: 1,
      nodeId: input.id,
      objective: `work:${input.id}`,
      profile,
      constraints: {
        maxWorkers: input.maxWorkers ?? 1,
        maxOutputTokens: 32_000,
        maxLatencyMs: 60_000,
        allowPaidFallback: false,
        ...(input.noRoute ? { allowedProviders: ['unavailable-provider'] } : {}),
        requiredTools: [],
      },
      readPaths: [`src/${input.id}.ts`],
      writePaths: [`src/${input.id}.ts`],
      dependsOn: [...(input.dependsOn ?? [])],
    })),
  })
}

function config(options: {
  readonly maxWorkers?: number
  readonly maxParallelWorkers?: number
  readonly scope?: 'level' | 'dag'
} = {}): OrchestratorConfig {
  return {
    workspaceRoot: '.',
    mode: 'single-worker',
    worker: { provider: 'provider-disabled', model: 'model-disabled', maxTokens: 32_000 },
    budgets: {
      maxWorkers: options.maxWorkers ?? 8,
      maxPluginToolActions: 16,
      toolTimeoutMs: 60_000,
    },
    verification: { commands: [], timeoutMs: 60_000, maxOutputBytes: 65_536 },
    parallel: {
      maxParallelWorkers: options.maxParallelWorkers ?? 4,
      verification: { schemaVersion: 1, scope: options.scope ?? 'level', commands: [] },
      workerToolAllowlist: [],
      routeToolFilters: {},
    },
  }
}

function completedHandoff(nodeId: string): HandoffV1 {
  return {
    schemaVersion: 1,
    status: 'completed',
    summary: `completed:${nodeId}`,
    changedFiles: [`src/${nodeId}.ts`],
    decisions: [],
    verification: [],
    blockers: [],
  }
}

function nodeIdFrom(request: SubagentStartRequest): string {
  const text = request.prompt[0]?.type === 'text' ? request.prompt[0].text : ''
  const match = /^work:([^\n]+)/u.exec(text)
  if (match?.[1] === undefined) throw new Error('missing node id in worker prompt')
  return match[1]
}

interface RuntimeFixture {
  readonly parent: Agent
  readonly session: Session
  readonly config: OrchestratorConfig
  readonly budgetRegistry: ReturnType<typeof createBudgetControllerRegistry>
  readonly starts: string[]
  readonly runtime: ReturnType<typeof createParallelExecutionRuntime>
  readonly request: (taskDag: TaskDagV1) => { readonly dag: TaskDagV1; readonly parent: Agent; readonly signal: AbortSignal }
}

function fixture(options: {
  readonly config?: OrchestratorConfig
  readonly session?: Session
  readonly start?: (request: SubagentStartRequest, index: number) => Promise<SubagentRun>
  readonly workerRefDigest?: (workerId: string) => string
} = {}): RuntimeFixture {
  const runtimeConfig = options.config ?? config()
  const session = options.session ?? Session.create(SessionId('parallel-root'))
  const parent = { session } as Agent
  const starts: string[] = []
  let startIndex = 0
  const start = vi.fn(async (_provider: 'spawn', request: SubagentStartRequest): Promise<SubagentRun> => {
    const nodeId = nodeIdFrom(request)
    starts.push(nodeId)
    const index = startIndex++
    if (options.start !== undefined) return options.start(request, index)
    return {
      id: SessionId(`child-${nodeId}-${index}`),
      result: Promise.resolve({ stopReason: 'completed', structured: completedHandoff(nodeId), output: [] }),
      dispose: vi.fn(async () => undefined),
    } as SubagentRun
  })
  const budgetRegistry = createBudgetControllerRegistry(runtimeConfig.budgets, () => () => undefined)
  const schedulerResolver: SchedulerResolver = { current: () => undefined }
  const runtime = createParallelExecutionRuntime({
    config: runtimeConfig,
    budgetRegistry,
    schedulerResolver,
    subagents: { start } as Pick<SubagentRuntime, 'start'>,
    appendAggregate: (target, aggregate) => target.append('dsh-plugin/parallel-finished', aggregate).seq,
    ...(options.workerRefDigest === undefined ? {} : { workerRefDigest: options.workerRefDigest }),
  })
  return {
    parent,
    session,
    config: runtimeConfig,
    budgetRegistry,
    starts,
    runtime,
    request: taskDag => ({ dag: taskDag, parent, signal: new AbortController().signal }),
  }
}

function eventData(session: Session, type: string): unknown[] {
  return session.events.filter(event => event.type === type).map(event => event.data)
}

function appendAnchor(session: Session, dagId: string): void {
  appendParallelStarted(session, {
    schemaVersion: 1,
    dagId,
    requests: [{
      fanoutId: `${dagId}:aggregate`,
      nodeId: 'anchor',
      requestId: `${dagId}:node:anchor`,
    }],
  })
}

describe('parallel runtime validation and deterministic identifiers', () => {
  it.each([
    ['non-ascii-root-é', 'INVALID_ROOT_SESSION_ID'],
    ['r'.repeat(49), 'INVALID_ROOT_SESSION_ID'],
  ] as const)('rejects root session %j before events or budget', async (sessionId, code) => {
    const test = fixture({ session: Session.create(SessionId(sessionId)) })
    const before = test.budgetRegistry.forRootSession(test.session.id).snapshot()

    await expect(test.runtime.run(test.request(dag([{ id: 'a' }])))).rejects.toMatchObject({
      name: 'ParallelRunValidationError',
      code,
    })

    expect(test.session.events).toEqual([])
    expect(test.budgetRegistry.forRootSession(test.session.id).snapshot()).toEqual(before)
  })

  it('rejects unknown run-envelope fields before events or budget', async () => {
    const test = fixture()
    const before = test.budgetRegistry.forRootSession(test.session.id).snapshot()

    await expect(test.runtime.run({
      ...test.request(dag([{ id: 'a' }])),
      policy: { scope: 'dag', commands: [] },
    } as never)).rejects.toThrow(/policy|unknown/u)

    expect(test.session.events).toEqual([])
    expect(test.budgetRegistry.forRootSession(test.session.id).snapshot()).toEqual(before)
  })

  it('rejects semantic DAG issues as frozen INVALID_DAG evidence before parallel-started', async () => {
    const test = fixture()
    const invalid = parseTaskDagV1({
      ...dag([{ id: 'a' }, { id: 'b' }]),
      nodes: dag([{ id: 'a' }, { id: 'b' }]).nodes.map(node => ({ ...node, writePaths: ['src/shared.ts'] })),
    })
    let caught: ParallelRunValidationError | undefined

    try {
      await test.runtime.run(test.request(invalid))
    } catch (error) {
      caught = error as ParallelRunValidationError
    }

    expect(caught).toMatchObject({ name: 'ParallelRunValidationError', code: 'INVALID_DAG' })
    expect(caught?.issues?.[0]).toMatchObject({ code: 'overlapping-access' })
    expect(Object.isFrozen(caught?.issues)).toBe(true)
    expect(Object.isFrozen(caught?.issues?.[0])).toBe(true)
    expect(test.session.events).toEqual([])
  })

  it('scans only parser-valid same-root anchors and rejects ordinal 1000 before append', async () => {
    const session = Session.create(SessionId('parallel-root'))
    appendAnchor(session, 'foreign-root:dag:999')
    appendAnchor(session, 'parallel-root:dag:not-decimal')
    appendAnchor(session, 'parallel-root:dag:1000-corrupt')
    appendAnchor(session, 'parallel-root:dag:999')
    const test = fixture({ session })
    const eventCount = session.events.length
    const before = test.budgetRegistry.forRootSession(session.id).snapshot()

    await expect(test.runtime.run(test.request(dag([{ id: 'a' }])))).rejects.toMatchObject({
      code: 'DAG_ID_EXHAUSTED',
    })

    expect(session.events).toHaveLength(eventCount)
    expect(test.budgetRegistry.forRootSession(session.id).snapshot()).toEqual(before)
  })

  it('recovers the next ordinal after a runtime reload and appends the manifest first', async () => {
    const test = fixture({ config: config({ scope: 'dag' }) })
    const first = await test.runtime.run(test.request(dag([{ id: 'a' }])))
    const reloaded = fixture({ config: test.config, session: test.session })
    const second = await reloaded.runtime.run(reloaded.request(dag([{ id: 'b' }])))

    expect(first.dagId).toBe('parallel-root:dag:1')
    expect(second.dagId).toBe('parallel-root:dag:2')
    expect(test.session.events[0]).toMatchObject({
      type: 'dsh-plugin/parallel-started',
      data: {
        dagId: 'parallel-root:dag:1',
        requests: [{
          fanoutId: 'parallel-root:dag:1:aggregate',
          nodeId: 'a',
          requestId: 'parallel-root:dag:1:node:a',
        }],
      },
    })
  })

  it('allocates from valid parallel-finished anchors as well as started anchors', () => {
    const test = fixture({ config: config({ scope: 'dag' }) })
    appendAnchor(test.session, 'parallel-root:dag:7')

    expect(allocateDagId(test.session)).toEqual({ dagId: 'parallel-root:dag:8', ordinal: 8 })
  })

  it('allocates distinct synchronous dagIds for concurrent run calls', async () => {
    const test = fixture({ config: config({ scope: 'dag' }) })

    const [left, right] = await Promise.all([
      test.runtime.run(test.request(dag([{ id: 'a' }]))),
      test.runtime.run(test.request(dag([{ id: 'b' }]))),
    ])

    expect(new Set([left.dagId, right.dagId])).toEqual(new Set([
      'parallel-root:dag:1',
      'parallel-root:dag:2',
    ]))
  })
})

describe('parallel runtime level flow', () => {
  it('runs readiness then classifies and atomically admits only executable nodes', async () => {
    const test = fixture()
    const controller = test.budgetRegistry.forRootSession(test.session.id)
    const result = await test.runtime.run(test.request(dag([
      { id: 'a', noRoute: true },
      { id: 'b' },
      { id: 'c', dependsOn: ['a'] },
    ])))

    expect(test.starts).toEqual(['b'])
    expect(controller.snapshot()).toMatchObject({ admittedWorkers: 1, admittedPluginToolActions: 1 })
    expect(result.finalAggregate.nodeResults).toMatchObject([
      { nodeId: 'a', status: 'not-run', reason: 'no-route' },
      { nodeId: 'b', status: 'completed', reason: 'completed' },
      { nodeId: 'c', status: 'not-run', reason: 'dependency-not-run' },
    ])
  })

  it('charges nothing and emits no level aggregate for a zero-executable level', async () => {
    const test = fixture()
    const controller = test.budgetRegistry.forRootSession(test.session.id)
    const before = controller.snapshot()
    const result = await test.runtime.run(test.request(dag([{ id: 'a', maxWorkers: 0 }])))

    expect(controller.snapshot()).toEqual(before)
    expect(result.aggregates.filter(item => item.scope === 'level')).toEqual([])
    expect(result.finalAggregate.nodeResults).toMatchObject([
      { nodeId: 'a', status: 'not-run', reason: 'zero-worker-constraint' },
    ])
  })

  it('preserves classified reasons and applies a global admission stop to rejected and later nodes', async () => {
    const test = fixture({ config: config({ maxWorkers: 5 }) })
    const controller = test.budgetRegistry.forRootSession(test.session.id)
    expect(controller.admitFanout(3)).toEqual({ allowed: true })
    const result = await test.runtime.run(test.request(dag([
      { id: 'seed' },
      { id: 'no-route', dependsOn: ['seed'], noRoute: true },
      { id: 'rejected-a', dependsOn: ['seed'] },
      { id: 'rejected-b', dependsOn: ['seed'] },
      { id: 'later', dependsOn: ['rejected-a'] },
    ])))

    expect(Object.fromEntries(result.finalAggregate.nodeResults.map(item => [item.nodeId, item.reason]))).toEqual({
      seed: 'completed',
      'no-route': 'no-route',
      'rejected-a': 'admission-rejected',
      'rejected-b': 'admission-rejected',
      later: 'admission-rejected',
    })
    expect(test.starts).toEqual(['seed'])
    expect(result.aggregates.filter(item => item.scope === 'level')).toHaveLength(1)
    expect(result.finalAggregate.aggregateStatus).toBe('blocked')
  })

  it('starts siblings concurrently after admission and returns canonical manifest order', async () => {
    const releases: Array<() => void> = []
    const test = fixture({
      start: async (request, index) => {
        const nodeId = nodeIdFrom(request)
        await new Promise<void>(resolve => releases.push(resolve))
        return {
          id: SessionId(`concurrent-${index}`),
          result: Promise.resolve({ stopReason: 'completed', structured: completedHandoff(nodeId), output: [] }),
          dispose: vi.fn(async () => undefined),
        } as SubagentRun
      },
    })
    const running = test.runtime.run(test.request(dag([{ id: 'b' }, { id: 'a' }])))
    await vi.waitFor(() => expect(test.starts).toEqual(['a', 'b']))
    expect(test.budgetRegistry.forRootSession(test.session.id).snapshot()).toMatchObject({ admittedWorkers: 2 })

    releases.forEach(release => release())
    const result = await running

    expect(result.finalAggregate.nodeResults.map(item => item.nodeId)).toEqual(['a', 'b'])
    expect(eventData(test.session, 'dsh-plugin/parallel-started')[0]).toMatchObject({
      requests: [{ nodeId: 'a' }, { nodeId: 'b' }],
    })
  })

  it('raises workerRef collision after worker events and before the level aggregate', async () => {
    const test = fixture({ workerRefDigest: () => 'a'.repeat(32) })

    await expect(test.runtime.run(test.request(dag([{ id: 'a' }, { id: 'b' }])))).rejects.toMatchObject({
      name: 'ParallelRunValidationError',
      code: 'WORKER_REF_COLLISION',
    })

    expect(eventData(test.session, 'dsh-plugin/worker-requested')).not.toEqual([])
    expect(eventData(test.session, 'dsh-plugin/parallel-finished')).toEqual([])
  })

  it('emits admitted level aggregates followed by one cumulative DAG aggregate', async () => {
    const test = fixture()
    const result = await test.runtime.run(test.request(dag([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
    ])))

    expect(result.aggregates.map(item => [item.scope, item.levelIndex])).toEqual([
      ['level', 0],
      ['level', 1],
      ['dag', undefined],
    ])
    expect(result.finalAggregate).toBe(result.aggregates[2])
    expect(result.finalAggregate.nodeResults.map(item => item.nodeId)).toEqual(['a', 'b'])
    expect(eventData(test.session, 'dsh-plugin/parallel-finished')).toHaveLength(3)
  })
})
