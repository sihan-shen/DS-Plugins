import { describe, expect, it } from 'vitest'
import {
  BUDGET_VIEW_V1_JSON_SCHEMA,
  SCHEDULE_FEEDBACK_V1_JSON_SCHEMA,
  SCHEDULE_SELECTED_V1_JSON_SCHEMA,
  parseBudgetViewV1,
  parseScheduleFeedbackV1,
  parseScheduleSelectedV1,
} from '../src/index.ts'

describe('BudgetViewV1', () => {
  it('accepts internally consistent counters and freezes the projection', () => {
    const view = parseBudgetViewV1({ maxWorkers: 1, admittedWorkers: 0, maxPluginToolActions: 24, admittedPluginToolActions: 3, remainingWorkers: 1, remainingPluginToolActions: 21 })
    expect(view).toEqual({ maxWorkers: 1, admittedWorkers: 0, maxPluginToolActions: 24, admittedPluginToolActions: 3, remainingWorkers: 1, remainingPluginToolActions: 21 })
    expect(Object.isFrozen(view)).toBe(true)
    expect('admitWorker' in view).toBe(false)
  })
  it('rejects forged remaining counts and methods', () => {
    expect(() => parseBudgetViewV1({ maxWorkers: 1, admittedWorkers: 0, maxPluginToolActions: 1, admittedPluginToolActions: 0, remainingWorkers: 0, remainingPluginToolActions: 1 })).toThrow()
    expect(() => parseBudgetViewV1({ maxWorkers: 1, admittedWorkers: 0, maxPluginToolActions: 1, admittedPluginToolActions: 0, remainingWorkers: 1, remainingPluginToolActions: 1, admitWorker() {} })).toThrow()
  })
})

describe('ScheduleFeedbackV1 and ScheduleSelectedV1', () => {
  it('projects bounded feedback through a JSON boundary and omits sensitive keys', () => {
    const feedback = parseScheduleFeedbackV1({ schemaVersion: 1, requestId: 'session-1', outcome: 'budget-rejected', budgetRejection: { code: 'WORKER_LIMIT', limit: 1, observed: 2 }, actual: { provider: 'provider-disabled', model: 'baseline-disabled', durationMs: 15, toolCalls: 0 } })
    expect(JSON.parse(JSON.stringify(feedback))).toEqual(feedback)
    expect(() => parseScheduleFeedbackV1({ ...feedback, transcript: 'SECRET' })).toThrow()
    expect(() => parseScheduleFeedbackV1({ ...feedback, outcome: 'budget-rejected', budgetRejection: undefined })).toThrow()
  })

  it('projects selected routes without credentials', () => {
    const selected = parseScheduleSelectedV1({ schemaVersion: 1, target: 'worker', source: 'scheduler', provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 32000, policyVersion: 'v0.3.0' })
    expect(selected).toEqual({ schemaVersion: 1, target: 'worker', source: 'scheduler', provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 32000, policyVersion: 'v0.3.0' })
    expect(() => parseScheduleSelectedV1({ ...selected, credential: 'SECRET' })).toThrow()
  })

  it('detaches and freezes nested handoff feedback', () => {
    const input = {
      schemaVersion: 1,
      requestId: 'session-1',
      outcome: 'completed',
      handoff: {
        schemaVersion: 1,
        status: 'completed',
        summary: 'Finished.',
        changedFiles: ['src/parser.ts'],
        decisions: ['Kept the parser strict.'],
        verification: [],
        blockers: [],
      },
      verification: [],
    }
    const feedback = parseScheduleFeedbackV1(input)
    expect(feedback.handoff).not.toBe(input.handoff)
    expect(feedback.handoff?.changedFiles).not.toBe(input.handoff.changedFiles)
    expect(Object.isFrozen(feedback)).toBe(true)
    expect(Object.isFrozen(feedback.handoff)).toBe(true)
    expect(Object.isFrozen(feedback.handoff?.changedFiles)).toBe(true)
    input.handoff.changedFiles.push('mutated.ts')
    expect(feedback.handoff?.changedFiles).toEqual(['src/parser.ts'])
  })

  it('exports closed, frozen schemas for all new contracts', () => {
    expect(BUDGET_VIEW_V1_JSON_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false })
    expect(SCHEDULE_FEEDBACK_V1_JSON_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false })
    expect(SCHEDULE_SELECTED_V1_JSON_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false })
    expectDeepFrozen(BUDGET_VIEW_V1_JSON_SCHEMA)
    expectDeepFrozen(SCHEDULE_FEEDBACK_V1_JSON_SCHEMA)
    expectDeepFrozen(SCHEDULE_SELECTED_V1_JSON_SCHEMA)
  })
})

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) return
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectDeepFrozen(child)
}
