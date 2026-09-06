export const FAILURE_CLASSES = [
  'context_loss',
  'insufficient_context',
  'context_bloat',
  'bad_reasoning',
  'wrong_model',
  'prompt_incompatibility',
  'tool_misuse',
  'premature_edit',
  'implementation_error',
  'verification_gap',
  'scope_creep',
  'bad_handoff',
  'bad_routing',
  'provider_failure',
  'budget_exhaustion',
] as const

export type FailureClassV1 = typeof FAILURE_CLASSES[number]
export type RefV1 = string
export type EvidenceRefV1 = { runRef: RefV1; seq: number }
export type EventKindV1 =
  | 'run-started'
  | 'schedule-selected'
  | 'worker-requested'
  | 'worker-finished'
  | 'budget-rejected'
  | 'verification-finished'
  | 'parallel-started'
  | 'parallel-finished'

export type ObservationV1 = {
  schemaVersion: 1
  domainRef: RefV1
  runRef: RefV1
  sessionRef: RefV1
  seq: number
  kind: EventKindV1
  observedAtMs: number
  facts: {
    routeRef?: RefV1
    requestRef?: RefV1
    fanoutRef?: RefV1
    nodeRef?: RefV1
    scope?: 'root' | 'worker' | 'level' | 'dag'
    status?:
      | 'completed'
      | 'blocked'
      | 'failed'
      | 'passed'
      | 'timed-out'
      | 'spawn-error'
      | 'verification-failed'
      | 'budget-rejected'
    durationMs?: number
  }
}

export type RunSealV1 = {
  schemaVersion: 1
  kind: 'run-seal'
  domainRef: RefV1
  runRef: RefV1
  observationCount: number
  lostCount: number
  complete: boolean
}

export type TelemetryRecordV1 = ObservationV1 | RunSealV1

export type RunAnnotationV1 = {
  schemaVersion: 1
  domainRef: RefV1
  runRef: RefV1
  taskInstanceRef: RefV1
  taskFamilyRef: RefV1
  configHash: RefV1
  promptHash: RefV1
  outcome: 'success' | 'failure' | 'unknown'
  accepted: boolean | null
  failure: {
    category: FailureClassV1
    evidence: EvidenceRefV1[]
    attribution: 'observed' | 'reviewed'
  } | null
  evidence: EvidenceRefV1[]
}

export type MetricV1 = {
  value: number | null
  numerator: number
  denominator: number
  observedRuns: number
  eligibleRuns: number
  basis: 'observed' | 'estimated' | 'unavailable'
}

export type DatasetV1 = {
  records: TelemetryRecordV1[]
  annotations: RunAnnotationV1[]
}

export type PatternV1 = {
  schemaVersion: 1
  id: RefV1
  category: FailureClassV1
  domainRef: RefV1
  taskFamilyRef: RefV1
  configHash: RefV1
  promptHash: RefV1
  runRefs: RefV1[]
  taskInstanceRefs: RefV1[]
  evidence: EvidenceRefV1[]
}

export type LessonV1 = {
  schemaVersion: 1
  id: RefV1
  revision: 1
  pattern: PatternV1
  rule:
    | 'review-context-boundary'
    | 'review-verification-scope'
    | 'review-route-fit'
    | 'review-failure-evidence'
}

export type CandidateV1 = {
  schemaVersion: 1
  id: RefV1
  revision: 1
  kind: 'skill' | 'prompt' | 'routing'
  status: 'proposed'
  lessonId: RefV1
  baseConfigHash: RefV1
  basePromptHash: RefV1
  hypothesis: LessonV1['rule']
  evidence: EvidenceRefV1[]
  evaluationRequired: true
  autoPromote: false
}

type JsonRecord = Record<string, unknown>

const REF_PATTERN = /^[0-9a-f]{64}$/u
const MAX_RECORD_BYTES = 8_192
const MAX_EVIDENCE_REFS = 32
const encoder = new TextEncoder()

function fail(path: string, message: string): never {
  throw new TypeError(`${path} ${message}`)
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
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

function assertJsonValue(value: unknown, path: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') {
    if (!isWellFormedUnicode(value)) fail(path, 'must contain well-formed Unicode')
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must be a finite JSON number')
    return
  }
  if (typeof value !== 'object') fail(path, 'must be a JSON value')
  if (seen.has(value)) fail(path, 'must not be cyclic')
  if (!Array.isArray(value) && !isPlainRecord(value)) fail(path, 'must be a plain JSON value')

  seen.add(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) fail(`${path}[${index}]`, 'is required')
      assertJsonValue(value[index], `${path}[${index}]`, seen)
    }
    if (Object.keys(value).some(key => !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length)) {
      fail(path, 'must not contain named properties')
    }
  } else {
    for (const key of Object.keys(value)) {
      if (!isWellFormedUnicode(key)) fail(path, 'keys must contain well-formed Unicode')
      assertJsonValue((value as JsonRecord)[key], `${path}.${key}`, seen)
    }
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(path, 'must not contain symbol keys')
  seen.delete(value)
}

function exactRecord(value: unknown, path: string, allowed: readonly string[]): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !isPlainRecord(value)) {
    fail(path, 'must be a plain object')
  }
  const record = value as JsonRecord
  const allowedSet = new Set(allowed)
  for (const key of Object.keys(record)) {
    if (!allowedSet.has(key)) fail(`${path}.${key}`, 'is not allowed')
  }
  if (Object.getOwnPropertySymbols(record).length !== 0) fail(path, 'must not contain symbol keys')
  return record
}

function required(record: JsonRecord, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, key)) fail(`${path}.${key}`, 'is required')
  return record[key]
}

function ref(value: unknown, path: string): RefV1 {
  if (typeof value !== 'string' || !REF_PATTERN.test(value)) fail(path, 'must be a 64-character lowercase hexadecimal reference')
  return value
}

function integer(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(path, 'must be a finite nonnegative safe integer')
  }
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) fail(path, 'is unsupported')
  return value as T
}

function parseCorrelation(record: JsonRecord, path: string): Pick<ObservationV1['facts'], 'requestRef' | 'fanoutRef' | 'nodeRef'> {
  const keys = ['requestRef', 'fanoutRef', 'nodeRef'] as const
  const present = keys.filter(key => Object.prototype.hasOwnProperty.call(record, key))
  if (present.length !== 0 && present.length !== keys.length) fail(path, 'must contain the complete correlation triple or none of it')
  if (present.length === 0) return {}
  return {
    requestRef: ref(record.requestRef, `${path}.requestRef`),
    fanoutRef: ref(record.fanoutRef, `${path}.fanoutRef`),
    nodeRef: ref(record.nodeRef, `${path}.nodeRef`),
  }
}

function parseFacts(kind: EventKindV1, value: unknown): ObservationV1['facts'] {
  const path = 'telemetryRecord.facts'
  switch (kind) {
    case 'run-started': {
      const input = exactRecord(value, path, ['routeRef', 'scope'])
      if (required(input, 'scope', path) !== 'root') fail(`${path}.scope`, 'must be root')
      return { routeRef: ref(required(input, 'routeRef', path), `${path}.routeRef`), scope: 'root' }
    }
    case 'schedule-selected': {
      const input = exactRecord(value, path, ['routeRef', 'scope', 'requestRef', 'fanoutRef', 'nodeRef'])
      const scope = oneOf(required(input, 'scope', path), ['root', 'worker'] as const, `${path}.scope`)
      const correlation = parseCorrelation(input, path)
      if (scope === 'root' && correlation.requestRef !== undefined) fail(path, 'root scope must not contain correlation references')
      return {
        routeRef: ref(required(input, 'routeRef', path), `${path}.routeRef`),
        scope,
        ...correlation,
      }
    }
    case 'worker-requested': {
      const input = exactRecord(value, path, ['scope', 'requestRef', 'fanoutRef', 'nodeRef'])
      if (required(input, 'scope', path) !== 'worker') fail(`${path}.scope`, 'must be worker')
      return { scope: 'worker', ...parseCorrelation(input, path) }
    }
    case 'worker-finished': {
      const input = exactRecord(value, path, ['scope', 'status', 'requestRef', 'fanoutRef', 'nodeRef'])
      if (required(input, 'scope', path) !== 'worker') fail(`${path}.scope`, 'must be worker')
      return {
        scope: 'worker',
        status: oneOf(required(input, 'status', path), ['completed', 'blocked', 'failed'] as const, `${path}.status`),
        ...parseCorrelation(input, path),
      }
    }
    case 'budget-rejected': {
      const input = exactRecord(value, path, ['status'])
      if (required(input, 'status', path) !== 'budget-rejected') fail(`${path}.status`, 'must be budget-rejected')
      return { status: 'budget-rejected' }
    }
    case 'verification-finished': {
      const input = exactRecord(value, path, ['status', 'durationMs'])
      const status = oneOf(required(input, 'status', path), ['passed', 'failed', 'timed-out', 'spawn-error'] as const, `${path}.status`)
      return {
        status,
        ...(Object.prototype.hasOwnProperty.call(input, 'durationMs')
          ? { durationMs: integer(input.durationMs, `${path}.durationMs`) }
          : {}),
      }
    }
    case 'parallel-started': {
      const input = exactRecord(value, path, ['fanoutRef', 'scope'])
      if (required(input, 'scope', path) !== 'dag') fail(`${path}.scope`, 'must be dag')
      return { fanoutRef: ref(required(input, 'fanoutRef', path), `${path}.fanoutRef`), scope: 'dag' }
    }
    case 'parallel-finished': {
      const input = exactRecord(value, path, ['fanoutRef', 'scope', 'status'])
      return {
        fanoutRef: ref(required(input, 'fanoutRef', path), `${path}.fanoutRef`),
        scope: oneOf(required(input, 'scope', path), ['level', 'dag'] as const, `${path}.scope`),
        status: oneOf(required(input, 'status', path), ['completed', 'blocked', 'failed', 'verification-failed'] as const, `${path}.status`),
      }
    }
  }
}

function parseObservation(value: unknown): ObservationV1 {
  const path = 'telemetryRecord'
  const input = exactRecord(value, path, [
    'schemaVersion', 'domainRef', 'runRef', 'sessionRef', 'seq', 'kind', 'observedAtMs', 'facts',
  ])
  if (required(input, 'schemaVersion', path) !== 1) fail(`${path}.schemaVersion`, 'must be 1')
  const kind = oneOf(required(input, 'kind', path), [
    'run-started', 'schedule-selected', 'worker-requested', 'worker-finished',
    'budget-rejected', 'verification-finished', 'parallel-started', 'parallel-finished',
  ] as const, `${path}.kind`)
  return {
    schemaVersion: 1,
    domainRef: ref(required(input, 'domainRef', path), `${path}.domainRef`),
    runRef: ref(required(input, 'runRef', path), `${path}.runRef`),
    sessionRef: ref(required(input, 'sessionRef', path), `${path}.sessionRef`),
    seq: integer(required(input, 'seq', path), `${path}.seq`),
    kind,
    observedAtMs: integer(required(input, 'observedAtMs', path), `${path}.observedAtMs`),
    facts: parseFacts(kind, required(input, 'facts', path)),
  }
}

function parseRunSeal(value: unknown): RunSealV1 {
  const path = 'telemetryRecord'
  const input = exactRecord(value, path, [
    'schemaVersion', 'kind', 'domainRef', 'runRef', 'observationCount', 'lostCount', 'complete',
  ])
  if (required(input, 'schemaVersion', path) !== 1) fail(`${path}.schemaVersion`, 'must be 1')
  if (required(input, 'kind', path) !== 'run-seal') fail(`${path}.kind`, 'must be run-seal')
  const lostCount = integer(required(input, 'lostCount', path), `${path}.lostCount`)
  const complete = required(input, 'complete', path)
  if (typeof complete !== 'boolean') fail(`${path}.complete`, 'must be a boolean')
  if (complete && lostCount !== 0) fail(`${path}.complete`, 'requires lostCount to be zero')
  return {
    schemaVersion: 1,
    kind: 'run-seal',
    domainRef: ref(required(input, 'domainRef', path), `${path}.domainRef`),
    runRef: ref(required(input, 'runRef', path), `${path}.runRef`),
    observationCount: integer(required(input, 'observationCount', path), `${path}.observationCount`),
    lostCount,
    complete,
  }
}

function parseEvidence(value: unknown, path: string): EvidenceRefV1 {
  const input = exactRecord(value, path, ['runRef', 'seq'])
  return {
    runRef: ref(required(input, 'runRef', path), `${path}.runRef`),
    seq: integer(required(input, 'seq', path), `${path}.seq`),
  }
}

function parseEvidenceList(value: unknown, path: string): EvidenceRefV1[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (value.length < 1 || value.length > MAX_EVIDENCE_REFS) {
    fail(path, `must contain between 1 and ${MAX_EVIDENCE_REFS} references`)
  }
  return value.map((item, index) => parseEvidence(item, `${path}[${index}]`))
}

/** Parse and detach one bounded, allowlisted telemetry record. */
export function parseTelemetryRecordV1(value: unknown): TelemetryRecordV1 {
  assertJsonValue(value, 'telemetryRecord')
  const serialized = JSON.stringify(value)
  if (encoder.encode(`${serialized}\n`).byteLength > MAX_RECORD_BYTES) fail('telemetryRecord', 'exceeds byte limit')
  const input = exactRecord(value, 'telemetryRecord', [
    'schemaVersion', 'kind', 'domainRef', 'runRef', 'sessionRef', 'seq', 'observedAtMs', 'facts',
    'observationCount', 'lostCount', 'complete',
  ])
  return input.kind === 'run-seal' ? parseRunSeal(value) : parseObservation(value)
}

/** Parse and detach an offline task annotation without inferring its outcome or acceptance. */
export function parseRunAnnotationV1(value: unknown): RunAnnotationV1 {
  assertJsonValue(value, 'runAnnotation')
  const path = 'runAnnotation'
  const input = exactRecord(value, path, [
    'schemaVersion', 'domainRef', 'runRef', 'taskInstanceRef', 'taskFamilyRef',
    'configHash', 'promptHash', 'outcome', 'accepted', 'failure', 'evidence',
  ])
  if (required(input, 'schemaVersion', path) !== 1) fail(`${path}.schemaVersion`, 'must be 1')
  const outcome = oneOf(required(input, 'outcome', path), ['success', 'failure', 'unknown'] as const, `${path}.outcome`)
  const accepted = required(input, 'accepted', path)
  if (accepted !== null && typeof accepted !== 'boolean') fail(`${path}.accepted`, 'must be boolean or null')

  const failureValue = required(input, 'failure', path)
  let failure: RunAnnotationV1['failure'] = null
  if (failureValue !== null) {
    const parsedFailure = exactRecord(failureValue, `${path}.failure`, ['category', 'evidence', 'attribution'])
    failure = {
      category: oneOf(required(parsedFailure, 'category', `${path}.failure`), FAILURE_CLASSES, `${path}.failure.category`),
      evidence: parseEvidenceList(required(parsedFailure, 'evidence', `${path}.failure`), `${path}.failure.evidence`),
      attribution: oneOf(required(parsedFailure, 'attribution', `${path}.failure`), ['observed', 'reviewed'] as const, `${path}.failure.attribution`),
    }
  }
  if (outcome === 'failure' && failure === null) fail(`${path}.failure`, 'is required for a failure outcome')
  if (outcome !== 'failure' && failure !== null) fail(`${path}.failure`, 'is only allowed for a failure outcome')

  return {
    schemaVersion: 1,
    domainRef: ref(required(input, 'domainRef', path), `${path}.domainRef`),
    runRef: ref(required(input, 'runRef', path), `${path}.runRef`),
    taskInstanceRef: ref(required(input, 'taskInstanceRef', path), `${path}.taskInstanceRef`),
    taskFamilyRef: ref(required(input, 'taskFamilyRef', path), `${path}.taskFamilyRef`),
    configHash: ref(required(input, 'configHash', path), `${path}.configHash`),
    promptHash: ref(required(input, 'promptHash', path), `${path}.promptHash`),
    outcome,
    accepted,
    failure,
    evidence: parseEvidenceList(required(input, 'evidence', path), `${path}.evidence`),
  }
}

function canonicalize(value: unknown, path: string, seen: WeakSet<object>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    assertJsonValue(value, path)
    return JSON.stringify(value)
  }
  if (typeof value !== 'object') fail(path, 'must be a JSON value')
  if (seen.has(value)) fail(path, 'must not be cyclic')
  if (!Array.isArray(value) && !isPlainRecord(value)) fail(path, 'must be a plain JSON value')
  seen.add(value)
  let result: string
  if (Array.isArray(value)) {
    assertJsonValue(value, path)
    result = `[${value.map((item, index) => canonicalize(item, `${path}[${index}]`, seen)).join(',')}]`
  } else {
    assertJsonValue(value, path)
    const input = value as JsonRecord
    result = `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonicalize(input[key], `${path}.${key}`, seen)}`).join(',')}}`
  }
  seen.delete(value)
  return result
}

/** Serialize JSON data with object keys sorted recursively. Array order is retained. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, 'value', new WeakSet<object>())
}
