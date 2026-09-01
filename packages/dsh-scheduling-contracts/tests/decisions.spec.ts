import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_REQUEST_V1_JSON_SCHEMA,
  parseCapabilityRequestV1,
  parseRouteDecisionV1,
  parseScheduleDecisionV1,
  SCHEDULE_DECISION_V1_JSON_SCHEMA,
} from '../src/index.ts'

const request = {
  schemaVersion: 1, target: 'worker', taskId: 'session-1', objective: 'Fix the parser.',
  profile: { coding: 90, reasoning: 70, toolUse: 40, repoContext: 80, risk: 20, difficulty: 60 },
  constraints: { maxWorkers: 1, maxOutputTokens: 32000, maxLatencyMs: 60000, allowPaidFallback: false, allowedProviders: ['provider-disabled'], requiredTools: ['targeted_verify'] },
  affinity: { workerId: 'session-1:worker:1', modelFamily: 'deepseek', snapshotId: 'snap-1' },
} as const

describe('CapabilityRequestV1', () => {
  it('returns a detached frozen JSON projection', () => {
    const parsed = parseCapabilityRequestV1(request)
    expect(parsed).toEqual(request)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.profile)).toBe(true)
    expect(CAPABILITY_REQUEST_V1_JSON_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false })
  })
  it.each([
    { ...request, authorization: 'secret' },
    { ...request, objective: 'x'.repeat(16_385) },
    { ...request, profile: { ...request.profile, risk: 101 } },
    { ...request, constraints: { ...request.constraints, maxWorkers: 2 } },
    { ...request, constraints: { ...request.constraints, maxOutputTokens: 128_001 } },
  ])('rejects unknown or out-of-bound input %#', value => {
    expect(() => parseCapabilityRequestV1(value)).toThrow()
  })
})

describe('RouteDecisionV1 and ScheduleDecisionV1', () => {
  const route = { provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 32000, reasoningEffort: 'high', promptProfile: 'coding-v1', modelFamily: 'deepseek' } as const

  it('parses exact route and schedule decisions', () => {
    expect(parseRouteDecisionV1(route)).toEqual(route)
    expect(parseScheduleDecisionV1({ schemaVersion: 1, mode: 'single-worker', route, workerCount: 1, source: 'scheduler', policyVersion: 'v0.3.0', affinityKey: 'session-1:worker:1:1', explanationCode: 'TASK_BASELINE' })).toMatchObject({ source: 'scheduler', route })
    expect(SCHEDULE_DECISION_V1_JSON_SCHEMA).toMatchObject({ additionalProperties: false })
  })

  it('rejects unsupported modes, worker counts, and route fields', () => {
    expect(() => parseScheduleDecisionV1({ schemaVersion: 1, mode: 'parallel-workers', route, workerCount: 2, source: 'scheduler', policyVersion: 'v0.3.0' })).toThrow()
    expect(() => parseRouteDecisionV1({ ...route, endpoint: 'https://example.invalid' })).toThrow()
  })
})
