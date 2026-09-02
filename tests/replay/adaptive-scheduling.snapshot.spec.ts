import { describe, expect, it } from 'vitest'
import { replayAdaptiveScheduling } from './adaptive-scheduling.fixture.ts'

describe('DSH v0.3 keyless adaptive scheduling replay', () => {
  it('covers fallback, scheduler, invalid, failure policy, Handoff escalation, ordering, and budget views', async () => {
    const replay = await replayAdaptiveScheduling()
    expect(replay.profileFallback).toMatchObject({ source: 'profile-fallback', route: { provider: 'provider-disabled', model: 'baseline-disabled' } })
    expect(replay.schedulerPresent).toMatchObject({ source: 'scheduler', policyVersion: 'v0.3.0' })
    expect(replay.invalidDecision).toMatchObject({ error: 'SCHEDULE_DECISION_INVALID', before: { admittedWorkers: 0, admittedPluginToolActions: 0 }, after: { admittedWorkers: 0, admittedPluginToolActions: 0 } })
    expect(replay.failurePolicy).toEqual({ quota: 'QUOTA_EXHAUSTED', timeout: 'fallback-disabled', cooldown: 'fallback-disabled', repeated: 'strong-disabled' })
    expect(replay.handoffEscalation).toMatchObject({ route: { model: 'strong-disabled' }, explanationCode: 'HANDOFF_ESCALATION' })
    expect(replay.workerEvents).toEqual(['dsh-plugin/schedule-selected', 'dsh-plugin/worker-requested', 'dsh-plugin/worker-finished'])
    expect(replay.rootEvents).toEqual(['dsh-plugin/schedule-selected', 'request/header', 'dsh-plugin/run-started'])
    expect(replay.directActualRoute).toEqual({ provider: 'actual-disabled', model: 'actual-model-disabled' })
    expect(replay.budgetView).toEqual({ maxWorkers: 1, admittedWorkers: 0, maxPluginToolActions: 24, admittedPluginToolActions: 0, remainingWorkers: 1, remainingPluginToolActions: 24 })
    expect(JSON.stringify(replay)).not.toMatch(/credential|authorization|transcript|SECRET_CHILD_OUTPUT/u)
  })
})
