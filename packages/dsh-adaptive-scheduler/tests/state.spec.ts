import { describe, expect, it, vi } from 'vitest'
import { createAdaptiveScheduler } from '../src/index.ts'
import { budget, request, schedulerConfig } from './policy.spec.ts'

const signal = new AbortController().signal

describe('adaptive scheduler state', () => {
  it('reuses one session route until fixed or idle expiry', async () => {
    let now = 1000
    const scheduler = createAdaptiveScheduler(schedulerConfig, { now: () => now, generation: 'g1' })
    const first = await scheduler.schedule(request, budget, signal)
    now += 100
    const sticky = await scheduler.schedule({ ...request, objective: 'Review the change' }, budget, signal)
    expect(sticky.route).toEqual(first.route)
    expect(sticky.explanationCode).toBe('STICKY_ROUTE')
    now += schedulerConfig.idleTtlMs + 1
    await expect(scheduler.schedule({ ...request, objective: 'Review the change' }, budget, signal)).resolves.toMatchObject({ explanationCode: 'TASK_BASELINE', route: { model: 'strong-disabled' } })
  })

  it('isolates HMR generations and freezes logical worker affinity', async () => {
    const first = createAdaptiveScheduler(schedulerConfig, { generation: 'g1' })
    const next = createAdaptiveScheduler(schedulerConfig, { generation: 'g2' })
    const a = await first.schedule({ ...request, affinity: { workerId: 'worker-1' } }, budget, signal)
    const b = await next.schedule({ ...request, affinity: { workerId: 'worker-1' } }, budget, signal)
    expect(a.affinityKey).not.toBe(b.affinityKey)
    expect(() => (a.route as { model: string }).model = 'mutated').toThrow()
  })
})
