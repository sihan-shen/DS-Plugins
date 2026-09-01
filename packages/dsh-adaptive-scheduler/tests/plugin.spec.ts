import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, createAdaptiveScheduler, inject, name, provide } from '../src/index.ts'
import { budget, request, schedulerConfig } from './policy.spec.ts'

describe('adaptive scheduler Cordis plugin', () => {
  it('exports stable lifecycle metadata and an apply entry', () => {
    expect(name).toBe('dsh-adaptive-scheduler')
    expect(provide).toEqual(['adaptiveScheduler'])
    expect(inject).toEqual([])
    expect(apply).toEqual(expect.any(Function))
  })

  it('provides one bounded service and disposes its generation', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(apply, schedulerConfig)
    const service = ctx.get('adaptiveScheduler')
    expect(service).toMatchObject({ schedule: expect.any(Function), observe: expect.any(Function) })
    await fiber.dispose()
    expect(ctx.get('adaptiveScheduler')).toBeUndefined()
  })

  it('escalates a later request from bounded failed Handoff feedback', async () => {
    const scheduler = createAdaptiveScheduler(schedulerConfig, { generation: 'g1' })
    await scheduler.schedule(request, budget, new AbortController().signal)
    scheduler.observe?.({ schemaVersion: 1, requestId: request.taskId, outcome: 'failed', handoff: { schemaVersion: 1, status: 'failed', summary: 'Parser remains blocked.', changedFiles: [], decisions: [], verification: [], blockers: ['Schema mismatch.'] } })
    await expect(scheduler.schedule({ ...request, priorHandoff: { schemaVersion: 1, status: 'failed', summary: 'Parser remains blocked.', changedFiles: [], decisions: [], verification: [], blockers: ['Schema mismatch.'] } }, budget, new AbortController().signal)).resolves.toMatchObject({ route: { model: 'strong-disabled' }, explanationCode: 'HANDOFF_ESCALATION' })
  })
})
