import { describe, expect, it } from 'vitest'
import {
  FAILURE_CLASSES,
  canonicalJson,
  parseRunAnnotationV1,
  parseTelemetryRecordV1,
} from '@ds-plugins/dsh-telemetry/contracts'

const ref = 'a'.repeat(64)
const otherRef = 'b'.repeat(64)

const observation = {
  schemaVersion: 1,
  domainRef: ref,
  runRef: ref,
  sessionRef: ref,
  seq: 1,
  kind: 'run-started',
  observedAtMs: 0,
  facts: { routeRef: ref, scope: 'root' },
} as const

const annotation = {
  schemaVersion: 1,
  domainRef: ref,
  runRef: ref,
  taskInstanceRef: ref,
  taskFamilyRef: ref,
  configHash: ref,
  promptHash: ref,
  outcome: 'failure',
  accepted: false,
  failure: {
    category: 'bad_reasoning',
    evidence: [{ runRef: ref, seq: 1 }],
    attribution: 'observed',
  },
  evidence: [{ runRef: ref, seq: 1 }],
} as const

describe('parseTelemetryRecordV1', () => {
  it('accepts a minimal allowlisted observation and returns a detached value', () => {
    const input = structuredClone(observation)
    const parsed = parseTelemetryRecordV1(input)

    expect(parsed).toEqual(observation)
    expect(parsed).not.toBe(input)
    expect('facts' in parsed && parsed.facts).not.toBe(input.facts)
  })

  it.each([
    ['unknown top-level field', { ...observation, secret: 'token' }],
    ['non-finite ordinal', { ...observation, seq: Number.POSITIVE_INFINITY }],
    ['negative timestamp', { ...observation, observedAtMs: -1 }],
    ['unsafe integer', { ...observation, seq: Number.MAX_SAFE_INTEGER + 1 }],
    ['private fact', { ...observation, facts: { stdout: 'private' } }],
    ['malformed reference', { ...observation, runRef: 'A'.repeat(64) }],
    ['unsupported schema', { ...observation, schemaVersion: 2 }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseTelemetryRecordV1(value)).toThrow(TypeError)
  })

  const eventCases = [
    ['run-started', { routeRef: ref, scope: 'root' }],
    ['schedule-selected', { routeRef: ref, scope: 'worker' }],
    ['schedule-selected', { routeRef: ref, scope: 'worker', requestRef: ref, fanoutRef: otherRef, nodeRef: ref }],
    ['worker-requested', { scope: 'worker' }],
    ['worker-requested', { scope: 'worker', requestRef: ref, fanoutRef: otherRef, nodeRef: ref }],
    ['worker-finished', { scope: 'worker', status: 'completed' }],
    ['worker-finished', { scope: 'worker', status: 'failed', requestRef: ref, fanoutRef: otherRef, nodeRef: ref }],
    ['budget-rejected', { status: 'budget-rejected' }],
    ['verification-finished', { status: 'passed', durationMs: 5 }],
    ['parallel-started', { fanoutRef: ref, scope: 'dag' }],
    ['parallel-finished', { fanoutRef: ref, scope: 'level', status: 'verification-failed' }],
  ] as const

  it.each(eventCases)('enforces the %s fact allowlist for %#', (kind, facts) => {
    const valid = { ...observation, kind, facts }
    expect(parseTelemetryRecordV1(valid)).toEqual(valid)
    expect(() => parseTelemetryRecordV1({ ...valid, facts: { ...facts, stdout: 'private' } })).toThrow(TypeError)
  })

  it.each([
    ['run-started', { scope: 'root' }],
    ['run-started', { routeRef: ref, scope: 'worker' }],
    ['schedule-selected', { routeRef: ref }],
    ['schedule-selected', { routeRef: ref, scope: 'root', requestRef: ref, fanoutRef: ref, nodeRef: ref }],
    ['schedule-selected', { routeRef: ref, scope: 'worker', requestRef: ref }],
    ['worker-requested', {}],
    ['worker-requested', { scope: 'worker', requestRef: ref, fanoutRef: ref }],
    ['worker-finished', { scope: 'worker' }],
    ['worker-finished', { scope: 'worker', status: 'passed' }],
    ['budget-rejected', { status: 'failed' }],
    ['verification-finished', { durationMs: 1 }],
    ['verification-finished', { status: 'completed' }],
    ['parallel-started', { fanoutRef: ref, scope: 'level' }],
    ['parallel-finished', { fanoutRef: ref, scope: 'dag' }],
  ] as const)('rejects invalid required facts for %s (%#)', (kind, facts) => {
    expect(() => parseTelemetryRecordV1({ ...observation, kind, facts })).toThrow(TypeError)
  })

  it('accepts a valid seal and treats complete as loss-free collection only', () => {
    const seal = {
      schemaVersion: 1,
      kind: 'run-seal',
      domainRef: ref,
      runRef: ref,
      observationCount: 0,
      lostCount: 0,
      complete: true,
    } as const

    expect(parseTelemetryRecordV1(seal)).toEqual(seal)
    expect(() => parseTelemetryRecordV1({ ...seal, lostCount: 1 })).toThrow(TypeError)
    expect(parseTelemetryRecordV1({ ...seal, complete: false })).toEqual({ ...seal, complete: false })
  })

  it('rejects records over 8 KiB in serialized UTF-8 including the newline', () => {
    const oversized = { ...observation, ['x'.repeat(8_192)]: true }
    expect(() => parseTelemetryRecordV1(oversized)).toThrow(/byte limit/u)
  })
})

describe('parseRunAnnotationV1', () => {
  it('accepts a strict failure annotation and detaches nested evidence', () => {
    const input = structuredClone(annotation)
    const parsed = parseRunAnnotationV1(input)

    expect(parsed).toEqual(annotation)
    expect(parsed).not.toBe(input)
    expect(parsed.evidence).not.toBe(input.evidence)
    expect(parsed.failure?.evidence).not.toBe(input.failure?.evidence)
  })

  it.each([
    ['unknown field', { ...annotation, notes: 'private' }],
    ['unknown failure field', { ...annotation, failure: { ...annotation.failure, reason: 'private' } }],
    ['unknown evidence field', { ...annotation, evidence: [{ runRef: ref, seq: 1, excerpt: 'private' }] }],
    ['empty evidence', { ...annotation, evidence: [] }],
    ['too much evidence', { ...annotation, evidence: Array.from({ length: 33 }, () => ({ runRef: ref, seq: 1 })) }],
    ['empty failure evidence', { ...annotation, failure: { ...annotation.failure, evidence: [] } }],
    ['invalid taxonomy', { ...annotation, failure: { ...annotation.failure, category: 'subjective' } }],
    ['failure without attribution', { ...annotation, failure: { category: 'bad_reasoning', evidence: annotation.failure.evidence } }],
    ['failed outcome without cause', { ...annotation, failure: null }],
    ['success with failure cause', { ...annotation, outcome: 'success' }],
    ['invalid accepted value', { ...annotation, accepted: 'yes' }],
    ['negative evidence ordinal', { ...annotation, evidence: [{ runRef: ref, seq: -1 }] }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseRunAnnotationV1(value)).toThrow(TypeError)
  })

  it.each(['success', 'unknown'] as const)('does not infer acceptance for %s outcomes', (outcome) => {
    const value = { ...annotation, outcome, accepted: null, failure: null }
    expect(parseRunAnnotationV1(value)).toEqual(value)
  })

  it('exports the complete stable failure taxonomy', () => {
    expect(FAILURE_CLASSES).toEqual([
      'context_loss', 'insufficient_context', 'context_bloat', 'bad_reasoning',
      'wrong_model', 'prompt_incompatibility', 'tool_misuse', 'premature_edit',
      'implementation_error', 'verification_gap', 'scope_creep', 'bad_handoff',
      'bad_routing', 'provider_failure', 'budget_exhaustion',
    ])
  })
})

describe('canonicalJson', () => {
  it('sorts object keys recursively while retaining array order', () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [{ b: 1, a: 2 }, 0] }))
      .toBe('{"a":{"x":3,"y":2},"list":[{"a":2,"b":1},0],"z":1}')
  })

  it.each([
    ['lone high surrogate', { value: '\ud800' }],
    ['lone low surrogate', { value: '\udc00' }],
    ['non-finite number', { value: Number.NaN }],
    ['undefined', { value: undefined }],
  ])('rejects %s', (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError)
  })
})
