import type { EventKindV1, ObservationV1, RefV1 } from './contracts.js'

type JsonRecord = Record<string, unknown>
type Facts = ObservationV1['facts']

const MAX_IDENTIFIER_BYTES = 16 * 1_024
const MAX_MANIFEST_REQUESTS = 16
const MAX_LEVEL_RESULTS = 8
const MAX_DAG_RESULTS = 16
const MAX_ARRAY_ITEMS = 128
const MAX_DURATION_MS = 600_000
const encoder = new TextEncoder()
const EVENT_PREFIX = 'dsh-plugin/'
const RECOGNIZED = new Set<EventKindV1>([
  'run-started',
  'schedule-selected',
  'worker-requested',
  'worker-finished',
  'budget-rejected',
  'verification-finished',
  'parallel-started',
  'parallel-finished',
])

function invalid(): never {
  throw new TypeError('Invalid telemetry event payload')
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

function record(value: unknown): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid()
  return value as JsonRecord
}

function ownValue(input: JsonRecord, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key)
  if (descriptor === undefined || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) invalid()
  return descriptor.value
}

function hasOwn(input: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key)
}

function schemaOne(input: JsonRecord): void {
  if (ownValue(input, 'schemaVersion') !== 1) invalid()
}

function identifier(input: JsonRecord, key: string): string {
  const value = ownValue(input, key)
  if (typeof value !== 'string' || value.length === 0 || !isWellFormedUnicode(value)) invalid()
  if (encoder.encode(value).byteLength > MAX_IDENTIFIER_BYTES) invalid()
  return value
}

function oneOf<T extends string>(input: JsonRecord, key: string, values: readonly T[]): T {
  const value = ownValue(input, key)
  if (typeof value !== 'string' || !values.includes(value as T)) invalid()
  return value as T
}

function nonnegativeInteger(input: JsonRecord, key: string): number {
  const value = ownValue(input, key)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid()
  return value
}

function positiveInteger(input: JsonRecord, key: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = nonnegativeInteger(input, key)
  if (value === 0 || value > maximum) invalid()
  return value
}

function text(input: JsonRecord, key: string): string {
  const value = ownValue(input, key)
  if (typeof value !== 'string') invalid()
  return value
}

function array(input: JsonRecord, key: string): readonly unknown[] {
  const value = ownValue(input, key)
  if (!Array.isArray(value)) invalid()
  return value
}

function boundedArray(input: JsonRecord, key: string, maximum = MAX_ARRAY_ITEMS): readonly unknown[] {
  const values = array(input, key)
  if (values.length > maximum) invalid()
  return values
}

function stringArray(input: JsonRecord, key: string): readonly string[] {
  const values = boundedArray(input, key)
  if (values.some(value => typeof value !== 'string')) invalid()
  return values as readonly string[]
}

function validateHandoff(value: unknown): { status: 'completed' | 'blocked' | 'failed' } {
  const handoff = record(value)
  schemaOne(handoff)
  const status = oneOf(handoff, 'status', ['completed', 'blocked', 'failed'] as const)
  text(handoff, 'summary')
  boundedArray(handoff, 'changedFiles')
  boundedArray(handoff, 'decisions')
  boundedArray(handoff, 'verification')
  boundedArray(handoff, 'blockers')
  return { status }
}

function validateVerification(value: unknown): 'passed' | 'failed' | 'timed-out' | 'spawn-error' {
  const evidence = record(value)
  schemaOne(evidence)
  identifier(evidence, 'commandName')
  stringArray(evidence, 'args')
  const exitCode = ownValue(evidence, 'exitCode')
  if (exitCode !== null && (typeof exitCode !== 'number' || !Number.isSafeInteger(exitCode) || exitCode < 0)) invalid()
  const status = oneOf(evidence, 'status', ['passed', 'failed', 'timed-out', 'spawn-error'] as const)
  text(evidence, 'stdout')
  text(evidence, 'stderr')
  if (typeof ownValue(evidence, 'truncated') !== 'boolean') invalid()
  const durationMs = nonnegativeInteger(evidence, 'durationMs')
  if (durationMs > MAX_DURATION_MS) invalid()
  return status
}

function validateManifest(input: JsonRecord): void {
  const requests = array(input, 'requests')
  if (requests.length === 0 || requests.length > MAX_MANIFEST_REQUESTS) invalid()
  const requestIds = new Set<string>()
  const nodeIds = new Set<string>()
  for (const value of requests) {
    const request = record(value)
    if (!hasOwn(request, 'requestId') || !hasOwn(request, 'fanoutId') || !hasOwn(request, 'nodeId')) invalid()
    const requestId = identifier(request, 'requestId')
    identifier(request, 'fanoutId')
    const nodeId = identifier(request, 'nodeId')
    if (requestIds.has(requestId) || nodeIds.has(nodeId)) invalid()
    requestIds.add(requestId)
    nodeIds.add(nodeId)
  }
}

type AggregateStatus = 'completed' | 'blocked' | 'failed' | 'verification-failed'
type NodeStatus = 'completed' | 'blocked' | 'failed' | 'ownership-violation' | 'not-run'
type VerificationOutcome = 'not-run-no-commands' | 'not-run-no-accepted-nodes' | 'passed' | 'command-failed' | 'admission-rejected'

function validateNodeResults(input: JsonRecord, maximum: number): readonly NodeStatus[] {
  const results = boundedArray(input, 'nodeResults', maximum)
  const statuses: NodeStatus[] = []
  for (const value of results) {
    const result = record(value)
    schemaOne(result)
    identifier(result, 'nodeId')
    identifier(result, 'requestId')
    const status = oneOf(result, 'status', ['completed', 'blocked', 'failed', 'ownership-violation', 'not-run'] as const)
    statuses.push(status)
  }
  return statuses
}

function derivedAggregateStatus(statuses: readonly NodeStatus[], outcome: VerificationOutcome): AggregateStatus {
  if (statuses.includes('failed')) return 'failed'
  if (statuses.some(status => status === 'ownership-violation' || status === 'blocked' || status === 'not-run')) return 'blocked'
  if (outcome === 'admission-rejected') return 'failed'
  if (outcome === 'command-failed') return 'verification-failed'
  if (outcome === 'not-run-no-accepted-nodes' || statuses.length === 0) return 'blocked'
  return 'completed'
}

function validateAggregate(input: JsonRecord): { scope: 'level' | 'dag'; status: AggregateStatus; fanoutId: string } {
  const dagId = identifier(input, 'dagId')
  const scope = oneOf(input, 'scope', ['level', 'dag'] as const)
  const fanoutId = identifier(input, 'fanoutId')
  if (scope === 'level') {
    const levelId = identifier(input, 'levelId')
    const levelIndex = nonnegativeInteger(input, 'levelIndex')
    if (levelIndex >= 4 || fanoutId !== levelId) invalid()
  } else if (hasOwn(input, 'levelId') || hasOwn(input, 'levelIndex') || fanoutId !== `${dagId}:aggregate`) {
    invalid()
  }
  const statuses = validateNodeResults(input, scope === 'level' ? MAX_LEVEL_RESULTS : MAX_DAG_RESULTS)
  const outcome = oneOf(input, 'verificationOutcome', ['not-run-no-commands', 'not-run-no-accepted-nodes', 'passed', 'command-failed', 'admission-rejected'] as const)
  const status = oneOf(input, 'aggregateStatus', ['completed', 'blocked', 'failed', 'verification-failed'] as const)
  boundedArray(input, 'ownershipViolations', MAX_DAG_RESULTS)
  validateHandoff(ownValue(input, 'projectedHandoff'))
  if (hasOwn(input, 'verification')) boundedArray(input, 'verification')
  if (derivedAggregateStatus(statuses, outcome) !== status) invalid()
  if (hasOwn(input, 'projectedHandoffTruncated') && ownValue(input, 'projectedHandoffTruncated') !== true) invalid()
  return { scope, status, fanoutId }
}

function correlation(input: JsonRecord, identify: (domain: string, value: string) => RefV1): Pick<Facts, 'requestRef' | 'fanoutRef' | 'nodeRef'> {
  const keys = ['requestId', 'fanoutId', 'nodeId'] as const
  const present = keys.filter(key => hasOwn(input, key))
  if (present.length === 0) return {}
  if (present.length !== keys.length) invalid()
  return {
    requestRef: identify('request', identifier(input, 'requestId')),
    fanoutRef: identify('fanout', identifier(input, 'fanoutId')),
    nodeRef: identify('node', identifier(input, 'nodeId')),
  }
}

function routeRef(input: JsonRecord, identify: (domain: string, value: string) => RefV1): RefV1 {
  const provider = identifier(input, 'provider')
  const model = identifier(input, 'model')
  return identify('route', JSON.stringify([provider, model]))
}

function projectFacts(
  kind: EventKindV1,
  value: unknown,
  identify: (domain: string, value: string) => RefV1,
): Facts {
  const input = record(value)
  schemaOne(input)
  switch (kind) {
    case 'run-started':
      oneOf(input, 'mode', ['direct', 'single-worker'] as const)
      return { routeRef: routeRef(input, identify), scope: 'root' }
    case 'schedule-selected': {
      const scope = oneOf(input, 'target', ['root', 'worker'] as const)
      oneOf(input, 'source', ['scheduler', 'profile-fallback'] as const)
      positiveInteger(input, 'maxTokens', 128_000)
      const correlated = correlation(input, identify)
      if (scope === 'root' && correlated.requestRef !== undefined) invalid()
      return { routeRef: routeRef(input, identify), scope, ...correlated }
    }
    case 'worker-requested':
      text(input, 'task')
      identifier(input, 'provider')
      identifier(input, 'model')
      positiveInteger(input, 'maxTokens', 128_000)
      array(input, 'allowedTools')
      if (ownValue(input, 'expectedOutput') !== 'handoff-v1') invalid()
      if (hasOwn(input, 'reasoningEffort')) identifier(input, 'reasoningEffort')
      return { scope: 'worker', ...correlation(input, identify) }
    case 'worker-finished': {
      const { status } = validateHandoff(ownValue(input, 'handoff'))
      const correlated = correlation(input, identify)
      const hasChildSessionId = hasOwn(input, 'childSessionId')
      const hasWorkerRef = hasOwn(input, 'workerRef')
      if (hasChildSessionId === hasWorkerRef) invalid()
      if (hasChildSessionId) {
        identifier(input, 'childSessionId')
        if (correlated.requestRef !== undefined) invalid()
      } else {
        identifier(input, 'workerRef')
        if (correlated.requestRef === undefined) invalid()
      }
      return { scope: 'worker', status, ...correlated }
    }
    case 'budget-rejected':
      text(input, 'reason')
      nonnegativeInteger(input, 'limit')
      nonnegativeInteger(input, 'observed')
      return { status: 'budget-rejected' }
    case 'verification-finished': {
      const status = validateVerification(input)
      return { status, durationMs: nonnegativeInteger(input, 'durationMs') }
    }
    case 'parallel-started':
      validateManifest(input)
      return { fanoutRef: identify('fanout', identifier(input, 'dagId')), scope: 'dag' }
    case 'parallel-finished': {
      const { scope, status, fanoutId } = validateAggregate(input)
      return { fanoutRef: identify('fanout', fanoutId), scope, status }
    }
  }
}

export function projectEvent(
  input: { type: string; data: unknown },
  metadata: Omit<ObservationV1, 'kind' | 'facts'>,
  identify: (domain: string, value: string) => RefV1,
): ObservationV1 | null {
  const kind = input.type.startsWith(EVENT_PREFIX)
    ? input.type.slice(EVENT_PREFIX.length) as EventKindV1
    : undefined
  if (kind === undefined || !RECOGNIZED.has(kind)) return null
  try {
    const facts = projectFacts(kind, input.data, identify)
    return {
      schemaVersion: metadata.schemaVersion,
      domainRef: metadata.domainRef,
      runRef: metadata.runRef,
      sessionRef: metadata.sessionRef,
      seq: metadata.seq,
      kind,
      observedAtMs: metadata.observedAtMs,
      facts,
    }
  } catch {
    invalid()
  }
}
