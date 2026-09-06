import { describe, expect, it } from 'vitest'
import { pseudonym } from '../src/identity.ts'
import { projectEvent } from '../src/project.ts'

const ref = 'a'.repeat(64)
const metadata = {
  schemaVersion: 1 as const,
  domainRef: ref,
  runRef: ref,
  sessionRef: ref,
  seq: 1,
  observedAtMs: 0,
}
const identify = (domain: string, value: string) =>
  pseudonym(new Uint8Array(32).fill(7), domain, value)

const triple = {
  fanoutId: 'fanout-private',
  nodeId: 'node-private',
  requestId: 'request-private',
}

const worker = {
  schemaVersion: 1,
  task: 'private task',
  provider: 'private provider',
  model: 'secret model',
  maxTokens: 1_000,
  allowedTools: ['private tool'],
  expectedOutput: 'handoff-v1',
}

const handoff = {
  schemaVersion: 1,
  status: 'completed',
  summary: 'private summary',
  changedFiles: ['/private/file'],
  decisions: ['private decision'],
  verification: [],
  blockers: ['private blocker'],
}

const verification = {
  schemaVersion: 1,
  commandName: 'private command',
  args: ['private arg'],
  exitCode: 1,
  status: 'failed',
  stdout: 'private stdout',
  stderr: 'private stderr',
  truncated: false,
  durationMs: 25,
} as const
const { stdout: _stdout, ...verificationWithoutStdout } = verification
const { blockers: _blockers, ...handoffWithoutBlockers } = handoff

function aggregate(aggregateStatus: 'completed' | 'blocked' | 'failed' | 'verification-failed') {
  const nodeStatus = aggregateStatus === 'completed' || aggregateStatus === 'verification-failed'
    ? 'completed'
    : aggregateStatus
  const nodeResult = {
    schemaVersion: 1,
    nodeId: triple.nodeId,
    requestId: triple.requestId,
    workerRef: `w:${'b'.repeat(32)}`,
    status: nodeStatus,
    reason: nodeStatus === 'completed' ? 'completed' : `${nodeStatus}-result`,
  }
  const verificationOutcome = aggregateStatus === 'verification-failed'
    ? 'command-failed'
    : 'not-run-no-commands'
  const projectedHandoff = aggregateStatus === 'verification-failed'
    ? { ...handoff, status: 'failed', verification: [verification] }
    : { ...handoff, status: nodeStatus }

  return {
    schemaVersion: 1,
    dagId: 'private dag',
    scope: 'dag',
    fanoutId: 'private dag:aggregate',
    nodeResults: [nodeResult],
    aggregateStatus,
    verificationOutcome,
    ...(aggregateStatus === 'verification-failed' ? { verification: [verification] } : {}),
    ownershipViolations: [],
    projectedHandoff,
  }
}

const eventCases = [
  {
    type: 'dsh-plugin/run-started',
    data: { schemaVersion: 1, mode: 'direct', provider: 'private provider', model: 'secret model' },
    kind: 'run-started',
    facts: { routeRef: identify('route', '["private provider","secret model"]'), scope: 'root' },
  },
  {
    type: 'dsh-plugin/schedule-selected',
    data: { schemaVersion: 1, target: 'worker', source: 'scheduler', provider: 'private provider', model: 'secret model', maxTokens: 1_000, ...triple },
    kind: 'schedule-selected',
    facts: {
      routeRef: identify('route', '["private provider","secret model"]'),
      requestRef: identify('request', triple.requestId),
      fanoutRef: identify('fanout', triple.fanoutId),
      nodeRef: identify('node', triple.nodeId),
      scope: 'worker',
    },
  },
  {
    type: 'dsh-plugin/worker-requested',
    data: { ...worker, ...triple },
    kind: 'worker-requested',
    facts: {
      requestRef: identify('request', triple.requestId),
      fanoutRef: identify('fanout', triple.fanoutId),
      nodeRef: identify('node', triple.nodeId),
      scope: 'worker',
    },
  },
  {
    type: 'dsh-plugin/worker-finished',
    data: { schemaVersion: 1, workerRef: `w:${'b'.repeat(32)}`, handoff, ...triple },
    kind: 'worker-finished',
    facts: {
      requestRef: identify('request', triple.requestId),
      fanoutRef: identify('fanout', triple.fanoutId),
      nodeRef: identify('node', triple.nodeId),
      scope: 'worker',
      status: 'completed',
    },
  },
  {
    type: 'dsh-plugin/budget-rejected',
    data: { schemaVersion: 1, reason: 'private arbitrary reason', limit: 1, observed: 2 },
    kind: 'budget-rejected',
    facts: { status: 'budget-rejected' },
  },
  {
    type: 'dsh-plugin/verification-finished',
    data: verification,
    kind: 'verification-finished',
    facts: { status: 'failed', durationMs: 25 },
  },
  {
    type: 'dsh-plugin/parallel-started',
    data: { schemaVersion: 1, dagId: 'private dag', requests: [triple] },
    kind: 'parallel-started',
    facts: { fanoutRef: identify('fanout', 'private dag'), scope: 'dag' },
  },
  {
    type: 'dsh-plugin/parallel-finished',
    data: aggregate('verification-failed'),
    kind: 'parallel-finished',
    facts: { fanoutRef: identify('fanout', 'private dag:aggregate'), scope: 'dag', status: 'verification-failed' },
  },
] as const

describe('projectEvent', () => {
  it.each(eventCases)('projects $kind using only its safe allowlisted facts', ({ type, data, kind, facts }) => {
    const raw = { type, data: structuredClone(data) }
    const before = structuredClone(raw)

    expect(projectEvent(raw, metadata, identify)).toEqual({ ...metadata, kind, facts })
    expect(raw).toEqual(before)
  })

  it('supports legacy worker records without inventing correlation references', () => {
    expect(projectEvent({ type: 'dsh-plugin/worker-requested', data: worker }, metadata, identify))
      .toEqual({ ...metadata, kind: 'worker-requested', facts: { scope: 'worker' } })
    expect(projectEvent({
      type: 'dsh-plugin/worker-finished',
      data: { schemaVersion: 1, childSessionId: 'private child', handoff: { ...handoff, status: 'blocked' } },
    }, metadata, identify)).toEqual({
      ...metadata,
      kind: 'worker-finished',
      facts: { scope: 'worker', status: 'blocked' },
    })
  })

  it.each(['completed', 'blocked', 'failed', 'verification-failed'] as const)(
    'maps parallel aggregate status %s exactly',
    (aggregateStatus) => {
      const result = projectEvent({
        type: 'dsh-plugin/parallel-finished',
        data: aggregate(aggregateStatus),
      }, metadata, identify)

      expect(result?.facts.status).toBe(aggregateStatus)
    },
  )

  it('maps every canonical verification status exactly', () => {
    for (const status of ['passed', 'failed', 'timed-out', 'spawn-error'] as const) {
      const result = projectEvent({
        type: 'dsh-plugin/verification-finished',
        data: { ...verification, status, exitCode: status === 'passed' ? 0 : 1, durationMs: 0 },
      }, metadata, identify)
      expect(result?.facts).toEqual({ status, durationMs: 0 })
    }
  })

  it('returns null for unrecognized event types without inspecting their data', () => {
    const data = Object.defineProperty({}, 'secret', { get: () => { throw new Error('must not inspect') } })

    expect(projectEvent({ type: 'dsh-plugin/private-future-event', data }, metadata, identify)).toBeNull()
  })

  it('does not inspect unrelated fields on recognized payloads', () => {
    const data = {
      schemaVersion: 1,
      mode: 'direct',
      provider: 'private provider',
      model: 'secret model',
    }
    Object.defineProperty(data, 'unrelatedSecret', {
      enumerable: true,
      get: () => { throw new Error('must not inspect unrelated fields') },
    })

    expect(projectEvent({ type: 'dsh-plugin/run-started', data }, metadata, identify)).toEqual({
      ...metadata,
      kind: 'run-started',
      facts: { routeRef: identify('route', '["private provider","secret model"]'), scope: 'root' },
    })
  })

  it.each([
    ['partial correlation triple', { type: 'dsh-plugin/worker-requested', data: { ...worker, requestId: 'private request' } }],
    ['wrong worker status', { type: 'dsh-plugin/worker-finished', data: { schemaVersion: 1, childSessionId: 'child', handoff: { ...handoff, status: 'passed' } } }],
    ['incomplete worker handoff', { type: 'dsh-plugin/worker-finished', data: { schemaVersion: 1, childSessionId: 'child', handoff: handoffWithoutBlockers } }],
    ['unrepresentable aggregate status', { type: 'dsh-plugin/parallel-finished', data: { ...aggregate('completed'), aggregateStatus: 'partial' } }],
    ['incomplete aggregate envelope', { type: 'dsh-plugin/parallel-finished', data: { ...aggregate('completed'), nodeResults: undefined } }],
    ['inconsistent aggregate status', { type: 'dsh-plugin/parallel-finished', data: { ...aggregate('completed'), aggregateStatus: 'failed' } }],
    ['level aggregate without level discriminants', { type: 'dsh-plugin/parallel-finished', data: { ...aggregate('completed'), scope: 'level' } }],
    ['wrong source schema', { type: 'dsh-plugin/run-started', data: { schemaVersion: 2, provider: 'private provider', model: 'secret model' } }],
    ['malformed worker route', { type: 'dsh-plugin/worker-requested', data: { ...worker, provider: 7 } }],
    ['malformed worker budget', { type: 'dsh-plugin/worker-requested', data: { ...worker, maxTokens: 0 } }],
    ['malformed budget counters', { type: 'dsh-plugin/budget-rejected', data: { schemaVersion: 1, reason: 'private reason', limit: -1, observed: 2 } }],
    ['malformed verification envelope', { type: 'dsh-plugin/verification-finished', data: { schemaVersion: 1, commandName: 7, args: [], exitCode: 0, status: 'passed', stdout: '', stderr: '', truncated: false, durationMs: 1 } }],
    ['verification without stdout', { type: 'dsh-plugin/verification-finished', data: verificationWithoutStdout }],
    ['verification with negative exit code', { type: 'dsh-plugin/verification-finished', data: { ...verification, exitCode: -1 } }],
    ['verification with non-string argument', { type: 'dsh-plugin/verification-finished', data: { ...verification, args: [7] } }],
    ['ambiguous legacy worker result', { type: 'dsh-plugin/worker-finished', data: { schemaVersion: 1, handoff } }],
    ['empty parallel manifest', { type: 'dsh-plugin/parallel-started', data: { schemaVersion: 1, dagId: 'private dag', requests: [] } }],
    ['partial parallel manifest triple', { type: 'dsh-plugin/parallel-started', data: { schemaVersion: 1, dagId: 'private dag', requests: [{ requestId: 'request' }] } }],
    ['oversized parallel manifest', { type: 'dsh-plugin/parallel-started', data: { schemaVersion: 1, dagId: 'private dag', requests: Array.from({ length: 17 }, (_, index) => ({ ...triple, nodeId: `node-${index}`, requestId: `request-${index}` })) } }],
    ['duplicate manifest request', { type: 'dsh-plugin/parallel-started', data: { schemaVersion: 1, dagId: 'private dag', requests: [triple, { ...triple, nodeId: 'other-node' }] } }],
    ['duplicate manifest node', { type: 'dsh-plugin/parallel-started', data: { schemaVersion: 1, dagId: 'private dag', requests: [triple, { ...triple, requestId: 'other-request' }] } }],
    ['overlong identifier', { type: 'dsh-plugin/parallel-started', data: { schemaVersion: 1, dagId: '私'.repeat(5_462), requests: [triple] } }],
  ])('rejects %s with one generic sanitized error', (_name, input) => {
    let thrown: unknown
    try {
      projectEvent(input, metadata, identify)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TypeError)
    expect((thrown as Error).message).toBe('Invalid telemetry event payload')
  })

  it('does not traverse or serialize nested secret fields', () => {
    const corpus = ['private task', 'private summary', '/private/file', 'private decision', 'private blocker', 'private arg', 'private stdout', 'private stderr', 'private arbitrary reason', 'secret model']

    for (const event of eventCases) {
      const serialized = JSON.stringify(projectEvent(event, metadata, identify))
      for (const secret of corpus) expect(serialized).not.toContain(secret)
    }
  })

  it('accepts well-formed Unicode identifiers and keeps identity domains distinct', () => {
    const result = projectEvent({
      type: 'dsh-plugin/schedule-selected',
      data: { schemaVersion: 1, target: 'worker', source: 'scheduler', provider: '提供商', model: '模型', maxTokens: 1_000, requestId: '同一', fanoutId: '同一', nodeId: '同一' },
    }, metadata, identify)

    expect(result?.facts.requestRef).not.toBe(result?.facts.fanoutRef)
    expect(result?.facts.fanoutRef).not.toBe(result?.facts.nodeRef)
  })
})
