import type {
  CapabilityProfileV1,
  CapabilityRequestV1,
  HandoffV1,
  RouteDecisionV1,
  ScheduleDecisionV1,
  SchedulingConstraintsV1,
  VerificationEvidenceV1,
} from './types.js'

export const MAX_SCHEDULING_STRING_BYTES = 16_384
export const MAX_SCHEDULING_IDENTIFIER_BYTES = 256
export const MAX_SCHEDULING_ITEMS = 128
export const MAX_SCHEDULING_LATENCY_MS = 600_000
export const MAX_SCHEDULING_OUTPUT_TOKENS = 128_000

type RecordValue = Record<string, unknown>
const textEncoder = new TextEncoder()

function fail(path: string, message: string): never {
  throw new TypeError(`${path} ${message}`)
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertJsonValue(value: unknown, path: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    fail(path, 'must be a JSON value')
  }
  if (typeof value !== 'object') fail(path, 'must be a JSON value')
  if (seen.has(value)) fail(path, 'must be a JSON value')
  if (!Array.isArray(value) && !isPlainRecord(value)) fail(path, 'must be a JSON value')

  seen.add(value)
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key !== 'length' && (typeof key !== 'string' || !/^\d+$/u.test(key))) {
        fail(path, 'must be a JSON value')
      }
    }
    for (const [index, item] of value.entries()) assertJsonValue(item, `${path}[${index}]`, seen)
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail(path, 'must be a JSON value')
      assertJsonValue((value as RecordValue)[key], `${path}.${key}`, seen)
    }
  }
  seen.delete(value)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as RecordValue)) deepFreeze(child)
  return Object.freeze(value)
}

function exactRecord(value: unknown, path: string, allowed: readonly string[]): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !isPlainRecord(value)) {
    fail(path, 'must be a plain object')
  }
  const record = value as RecordValue
  const allowedSet = new Set(allowed)
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !allowedSet.has(key)) fail(`${path}.${String(key)}`, 'is not allowed')
  }
  return record
}

function required(record: RecordValue, name: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, name)) fail(`${path}.${name}`, 'is required')
  return record[name]
}

function boundedText(value: unknown, path: string, allowEmpty = true): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  if (!allowEmpty && value.trim() === '') fail(path, 'must be a non-empty string')
  if (value.includes('\0')) fail(path, 'must not contain a NUL byte')
  if (textEncoder.encode(value).byteLength > MAX_SCHEDULING_STRING_BYTES) {
    fail(path, `must not exceed ${MAX_SCHEDULING_STRING_BYTES} UTF-8 bytes`)
  }
  return value
}

function boundedIdentifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty identifier')
  if (value.includes('\0')) fail(path, 'must not contain a NUL byte')
  if (textEncoder.encode(value).byteLength > MAX_SCHEDULING_IDENTIFIER_BYTES) {
    fail(path, `must not exceed ${MAX_SCHEDULING_IDENTIFIER_BYTES} UTF-8 bytes`)
  }
  return value
}

function optionalIdentifier(record: RecordValue, name: string, path: string): Record<string, string> {
  if (!Object.prototype.hasOwnProperty.call(record, name)) return {}
  return { [name]: boundedIdentifier(record[name], path) }
}

function boundedNumber(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(path, `must be between ${minimum} and ${maximum}`)
  }
  return value
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(path, `must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function boundedStringArray(value: unknown, path: string, identifier = false): readonly string[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (value.length > MAX_SCHEDULING_ITEMS) fail(path, `must not contain more than ${MAX_SCHEDULING_ITEMS} items`)
  return value.map((item, index) => identifier
    ? boundedIdentifier(item, `${path}[${index}]`)
    : boundedText(item, `${path}[${index}]`))
}

function parseVerificationEvidence(value: unknown, index: number): VerificationEvidenceV1 {
  const path = `priorHandoff.verification[${index}]`
  const evidence = exactRecord(value, path, [
    'schemaVersion', 'commandName', 'args', 'exitCode', 'status', 'stdout', 'stderr', 'truncated', 'durationMs',
  ])
  if (evidence.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must be 1')
  const exitCode = required(evidence, 'exitCode', path)
  if (exitCode !== null) boundedInteger(exitCode, `${path}.exitCode`, 0, Number.MAX_SAFE_INTEGER)
  const status = required(evidence, 'status', path)
  if (status !== 'passed' && status !== 'failed' && status !== 'timed-out' && status !== 'spawn-error') {
    fail(`${path}.status`, 'is unsupported')
  }
  const truncated = required(evidence, 'truncated', path)
  if (typeof truncated !== 'boolean') fail(`${path}.truncated`, 'must be a boolean')
  return {
    schemaVersion: 1,
    commandName: boundedIdentifier(required(evidence, 'commandName', path), `${path}.commandName`),
    args: boundedStringArray(required(evidence, 'args', path), `${path}.args`),
    exitCode: exitCode as number | null,
    status,
    stdout: boundedText(required(evidence, 'stdout', path), `${path}.stdout`),
    stderr: boundedText(required(evidence, 'stderr', path), `${path}.stderr`),
    truncated,
    durationMs: boundedInteger(required(evidence, 'durationMs', path), `${path}.durationMs`, 0, MAX_SCHEDULING_LATENCY_MS),
  }
}

function parseHandoff(value: unknown): HandoffV1 {
  const handoff = exactRecord(value, 'priorHandoff', [
    'schemaVersion', 'status', 'summary', 'changedFiles', 'decisions', 'verification', 'blockers',
  ])
  if (handoff.schemaVersion !== 1) fail('priorHandoff.schemaVersion', 'must be 1')
  const status = required(handoff, 'status', 'priorHandoff')
  if (status !== 'completed' && status !== 'blocked' && status !== 'failed') fail('priorHandoff.status', 'is unsupported')
  const verificationValue = required(handoff, 'verification', 'priorHandoff')
  if (!Array.isArray(verificationValue)) fail('priorHandoff.verification', 'must be an array')
  if (verificationValue.length > MAX_SCHEDULING_ITEMS) fail('priorHandoff.verification', `must not contain more than ${MAX_SCHEDULING_ITEMS} items`)
  const verification = verificationValue.map(parseVerificationEvidence)
  const summary = boundedText(required(handoff, 'summary', 'priorHandoff'), 'priorHandoff.summary')
  if (status === 'completed' && verification.some(item => item.status !== 'passed') && !summary.includes('[verification: failed]')) {
    fail('priorHandoff.summary', 'must include [verification: failed] for unsuccessful verification')
  }
  return {
    schemaVersion: 1,
    status,
    summary,
    changedFiles: boundedStringArray(required(handoff, 'changedFiles', 'priorHandoff'), 'priorHandoff.changedFiles'),
    decisions: boundedStringArray(required(handoff, 'decisions', 'priorHandoff'), 'priorHandoff.decisions'),
    verification,
    blockers: boundedStringArray(required(handoff, 'blockers', 'priorHandoff'), 'priorHandoff.blockers'),
  }
}

function parseProfile(value: unknown): CapabilityProfileV1 {
  const profile = exactRecord(value, 'profile', ['coding', 'reasoning', 'toolUse', 'repoContext', 'risk', 'difficulty'])
  return {
    coding: boundedNumber(required(profile, 'coding', 'profile'), 'profile.coding', 0, 100),
    reasoning: boundedNumber(required(profile, 'reasoning', 'profile'), 'profile.reasoning', 0, 100),
    toolUse: boundedNumber(required(profile, 'toolUse', 'profile'), 'profile.toolUse', 0, 100),
    repoContext: boundedNumber(required(profile, 'repoContext', 'profile'), 'profile.repoContext', 0, 100),
    risk: boundedNumber(required(profile, 'risk', 'profile'), 'profile.risk', 0, 100),
    difficulty: boundedNumber(required(profile, 'difficulty', 'profile'), 'profile.difficulty', 0, 100),
  }
}

function parseConstraints(value: unknown): SchedulingConstraintsV1 {
  const constraints = exactRecord(value, 'constraints', [
    'maxWorkers', 'maxOutputTokens', 'maxLatencyMs', 'allowPaidFallback', 'allowedProviders', 'requiredTools',
  ])
  const maxWorkers = required(constraints, 'maxWorkers', 'constraints')
  if (maxWorkers !== 0 && maxWorkers !== 1) fail('constraints.maxWorkers', 'must be 0 or 1')
  const allowPaidFallback = required(constraints, 'allowPaidFallback', 'constraints')
  if (typeof allowPaidFallback !== 'boolean') fail('constraints.allowPaidFallback', 'must be a boolean')
  return {
    maxWorkers,
    maxOutputTokens: boundedInteger(required(constraints, 'maxOutputTokens', 'constraints'), 'constraints.maxOutputTokens', 1, MAX_SCHEDULING_OUTPUT_TOKENS),
    maxLatencyMs: boundedInteger(required(constraints, 'maxLatencyMs', 'constraints'), 'constraints.maxLatencyMs', 1, MAX_SCHEDULING_LATENCY_MS),
    allowPaidFallback,
    ...(Object.prototype.hasOwnProperty.call(constraints, 'allowedProviders')
      ? { allowedProviders: boundedStringArray(constraints.allowedProviders, 'constraints.allowedProviders', true) }
      : {}),
    requiredTools: boundedStringArray(required(constraints, 'requiredTools', 'constraints'), 'constraints.requiredTools', true),
  }
}

function parseAffinity(value: unknown): NonNullable<CapabilityRequestV1['affinity']> {
  const affinity = exactRecord(value, 'affinity', ['workerId', 'modelFamily', 'snapshotId'])
  return {
    ...optionalIdentifier(affinity, 'workerId', 'affinity.workerId'),
    ...optionalIdentifier(affinity, 'modelFamily', 'affinity.modelFamily'),
    ...optionalIdentifier(affinity, 'snapshotId', 'affinity.snapshotId'),
  }
}

export function parseCapabilityRequestV1(value: unknown): CapabilityRequestV1 {
  assertJsonValue(value, 'request')
  const request = exactRecord(value, 'request', [
    'schemaVersion', 'target', 'taskId', 'objective', 'profile', 'constraints', 'workspaceFingerprint', 'repoRevision', 'affinity', 'priorHandoff',
  ])
  if (request.schemaVersion !== 1) fail('request.schemaVersion', 'must be 1')
  const target = request.target
  if (target !== 'root' && target !== 'worker') fail('request.target', 'is unsupported')
  return deepFreeze({
    schemaVersion: 1,
    target,
    taskId: boundedIdentifier(required(request, 'taskId', 'request'), 'request.taskId'),
    objective: boundedText(required(request, 'objective', 'request'), 'request.objective', false),
    profile: parseProfile(required(request, 'profile', 'request')),
    constraints: parseConstraints(required(request, 'constraints', 'request')),
    ...(Object.prototype.hasOwnProperty.call(request, 'workspaceFingerprint')
      ? { workspaceFingerprint: boundedIdentifier(request.workspaceFingerprint, 'request.workspaceFingerprint') }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(request, 'repoRevision')
      ? { repoRevision: boundedIdentifier(request.repoRevision, 'request.repoRevision') }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(request, 'affinity') ? { affinity: parseAffinity(request.affinity) } : {}),
    ...(Object.prototype.hasOwnProperty.call(request, 'priorHandoff') ? { priorHandoff: parseHandoff(request.priorHandoff) } : {}),
  })
}

export function parseRouteDecisionV1(value: unknown): RouteDecisionV1 {
  assertJsonValue(value, 'route')
  const route = exactRecord(value, 'route', ['provider', 'model', 'maxTokens', 'reasoningEffort', 'promptProfile', 'modelFamily'])
  return deepFreeze({
    provider: boundedIdentifier(required(route, 'provider', 'route'), 'route.provider'),
    model: boundedIdentifier(required(route, 'model', 'route'), 'route.model'),
    maxTokens: boundedInteger(required(route, 'maxTokens', 'route'), 'route.maxTokens', 1, MAX_SCHEDULING_OUTPUT_TOKENS),
    ...optionalIdentifier(route, 'reasoningEffort', 'route.reasoningEffort'),
    ...optionalIdentifier(route, 'promptProfile', 'route.promptProfile'),
    ...optionalIdentifier(route, 'modelFamily', 'route.modelFamily'),
  })
}

export function parseScheduleDecisionV1(value: unknown): ScheduleDecisionV1 {
  assertJsonValue(value, 'decision')
  const input = exactRecord(value, 'decision', ['schemaVersion', 'mode', 'route', 'workerCount', 'source', 'policyVersion', 'affinityKey', 'explanationCode'])
  if (input.schemaVersion !== 1) fail('decision.schemaVersion', 'must be 1')
  if (input.mode !== 'direct' && input.mode !== 'single-worker') fail('decision.mode', 'is unsupported')
  if (input.workerCount !== 0 && input.workerCount !== 1) fail('decision.workerCount', 'must be 0 or 1')
  if (input.mode === 'direct' && input.workerCount !== 0) fail('decision.workerCount', 'must be 0 for direct mode')
  if (input.mode === 'single-worker' && input.workerCount !== 1) fail('decision.workerCount', 'must be 1 for single-worker mode')
  if (input.source !== 'scheduler' && input.source !== 'profile-fallback') fail('decision.source', 'is unsupported')
  return deepFreeze({
    schemaVersion: 1,
    mode: input.mode,
    route: parseRouteDecisionV1(required(input, 'route', 'decision')),
    workerCount: input.workerCount,
    source: input.source,
    policyVersion: boundedIdentifier(required(input, 'policyVersion', 'decision'), 'decision.policyVersion'),
    ...optionalIdentifier(input, 'affinityKey', 'decision.affinityKey'),
    ...optionalIdentifier(input, 'explanationCode', 'decision.explanationCode'),
  })
}
