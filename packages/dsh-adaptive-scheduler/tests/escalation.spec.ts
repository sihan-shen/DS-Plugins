import { describe, expect, it } from 'vitest'
import { createAdaptiveScheduler } from '../src/index.ts'
import { budget, request, schedulerConfig } from './policy.spec.ts'

const signal = new AbortController().signal

describe('adaptive scheduler escalation', () => {
  it('uses one same-tier fallback, then bounded strong escalation, then expires', async () => {
    let now = 1000
    const scheduler = createAdaptiveScheduler(schedulerConfig, { now: () => now, generation: 'g1' })
    await scheduler.schedule(request, budget, signal)
    scheduler.recordFailure({ requestId: request.taskId, code: 'TIMEOUT' })
    await expect(scheduler.schedule(request, budget, signal)).resolves.toMatchObject({ route: { model: 'fallback-disabled' }, explanationCode: 'TRANSIENT_FALLBACK' })
    scheduler.recordFailure({ requestId: request.taskId, code: 'SERVER' })
    await expect(scheduler.schedule(request, budget, signal)).resolves.toMatchObject({ route: { model: 'strong-disabled' }, explanationCode: 'ADAPTIVE_ESCALATION' })
    now += schedulerConfig.escalationTtlMs + 1
    await expect(scheduler.schedule(request, budget, signal)).resolves.toMatchObject({ route: { model: 'baseline-disabled' } })
  })

  it('expires escalation at the exact TTL boundary', async () => {
    let now = 1000
    const scheduler = createAdaptiveScheduler(schedulerConfig, { now: () => now, generation: 'g1' })
    await scheduler.schedule(request, budget, signal)
    scheduler.recordFailure({ requestId: request.taskId, code: 'TIMEOUT' })
    await scheduler.schedule(request, budget, signal)
    scheduler.recordFailure({ requestId: request.taskId, code: 'SERVER' })
    await expect(scheduler.schedule(request, budget, signal)).resolves.toMatchObject({ route: { model: 'strong-disabled' } })

    now += schedulerConfig.escalationTtlMs
    await expect(scheduler.schedule(request, budget, signal)).resolves.toMatchObject({
      explanationCode: 'TASK_BASELINE',
      route: { model: 'baseline-disabled' },
    })
  })

  it.each(['QUOTA', 'AUTH'] as const)('hard-rejects %s without paid or same-tier fallback', async code => {
    const scheduler = createAdaptiveScheduler(schedulerConfig, { generation: 'g1' })
    scheduler.recordFailure({ requestId: request.taskId, code })
    await expect(scheduler.schedule(request, budget, signal)).rejects.toThrow(code === 'QUOTA' ? 'QUOTA_EXHAUSTED' : 'NON_TRANSIENT_FAILURE')
  })

  it('enforces maxRounds and maxEscalationsPerTask without an unbounded retry loop', async () => {
    const scheduler = createAdaptiveScheduler({ ...schedulerConfig, maxRounds: 2, maxEscalationsPerTask: 1 }, { generation: 'g1' })
    scheduler.recordFailure({ requestId: request.taskId, code: 'TIMEOUT' })
    await scheduler.schedule(request, budget, signal)
    scheduler.recordFailure({ requestId: request.taskId, code: 'SERVER' })
    await scheduler.schedule(request, budget, signal)
    scheduler.recordFailure({ requestId: request.taskId, code: 'TRANSPORT' })
    await expect(scheduler.schedule(request, budget, signal)).rejects.toThrow('ESCALATION_ROUNDS_EXHAUSTED')
  })

  it('records bounded route switches with previous route and generation', async () => {
    const scheduler = createAdaptiveScheduler(schedulerConfig, { generation: 'g1' })
    await scheduler.schedule(request, budget, signal)
    scheduler.recordFailure({ requestId: request.taskId, code: 'TIMEOUT' })
    await scheduler.schedule(request, budget, signal)
    expect(scheduler.switches()).toEqual([expect.objectContaining({ requestId: request.taskId, generation: 'g1', reason: 'TRANSIENT_FALLBACK', previousRoute: expect.objectContaining({ model: 'baseline-disabled' }), nextRoute: expect.objectContaining({ model: 'fallback-disabled' }) })])
    expect(scheduler.switches().length).toBeLessThanOrEqual(64)
  })

  it('keeps Handoff escalation above a transient failure fallback', async () => {
    const scheduler = createAdaptiveScheduler(schedulerConfig, { generation: 'g1' })
    scheduler.recordFailure({ requestId: 'handoff-next', code: 'TIMEOUT' })
    await expect(scheduler.schedule({
      ...request,
      taskId: 'handoff-next',
      priorHandoff: {
        schemaVersion: 1,
        status: 'failed',
        summary: 'Parser remains blocked.',
        changedFiles: [],
        decisions: [],
        verification: [],
        blockers: ['Schema mismatch.'],
      },
    }, budget, signal)).resolves.toMatchObject({
      route: { model: 'strong-disabled' },
      explanationCode: 'HANDOFF_ESCALATION',
    })
  })
})
