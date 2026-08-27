import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import {
  BudgetController,
  createBudgetControllerRegistry,
  mountBudgetControllerRegistry,
  type BudgetRejection,
} from '../src/budgets.ts'
import type { OrchestratorConfig } from '../src/types.ts'

const budgets: OrchestratorConfig['budgets'] = {
  maxWorkers: 1,
  maxPluginToolActions: 2,
  toolTimeoutMs: 30_000,
}

function rejections(): { readonly values: BudgetRejection[]; readonly record: (rejection: BudgetRejection) => void } {
  const values: BudgetRejection[] = []
  return {
    values,
    record(rejection) {
      values.push(rejection)
    },
  }
}

describe('deterministic budget admission', () => {
  it('rejects the first worker in Direct mode and records its exact rejected observation', () => {
    const recorder = rejections()
    const controller = new BudgetController({ ...budgets, maxWorkers: 0 }, recorder.record)

    expect(controller.admitWorker()).toEqual({
      allowed: false,
      code: 'WORKER_LIMIT',
      limit: 0,
      observed: 1,
    })
    expect(recorder.values).toEqual([{ code: 'WORKER_LIMIT', limit: 0, observed: 1 }])
  })

  it('admits exactly one worker and keeps rejection observations stable without incrementing', () => {
    const recorder = rejections()
    const controller = new BudgetController(budgets, recorder.record)

    expect(controller.admitWorker()).toEqual({ allowed: true })
    expect(controller.admitWorker()).toEqual({
      allowed: false,
      code: 'WORKER_LIMIT',
      limit: 1,
      observed: 2,
    })
    expect(controller.admitWorker()).toEqual({
      allowed: false,
      code: 'WORKER_LIMIT',
      limit: 1,
      observed: 2,
    })
    expect(recorder.values).toEqual([
      { code: 'WORKER_LIMIT', limit: 1, observed: 2 },
      { code: 'WORKER_LIMIT', limit: 1, observed: 2 },
    ])
  })

  it('counts only the two registered plugin tools and rejects excess actions without incrementing', () => {
    const recorder = rejections()
    const controller = new BudgetController(budgets, recorder.record)

    expect(controller.admitPluginTool('targeted_verify')).toEqual({ allowed: true })
    expect(controller.admitPluginTool('delegate_worker')).toEqual({ allowed: true })
    expect(controller.admitPluginTool('targeted_verify')).toEqual({
      allowed: false,
      code: 'PLUGIN_TOOL_LIMIT',
      limit: 2,
      observed: 3,
    })
    expect(controller.admitPluginTool('targeted_verify')).toEqual({
      allowed: false,
      code: 'PLUGIN_TOOL_LIMIT',
      limit: 2,
      observed: 3,
    })
    expect(() => controller.admitPluginTool('arbitrary-tool' as never)).toThrow(/unknown plugin tool action/i)
    expect(recorder.values).toEqual([
      { code: 'PLUGIN_TOOL_LIMIT', limit: 2, observed: 3 },
      { code: 'PLUGIN_TOOL_LIMIT', limit: 2, observed: 3 },
    ])
  })

  it('rejects disposed admissions with the configured limit and a non-incrementing next observation', () => {
    const recorder = rejections()
    const controller = new BudgetController(budgets, recorder.record)

    expect(controller.admitWorker()).toEqual({ allowed: true })
    expect(controller.admitPluginTool('targeted_verify')).toEqual({ allowed: true })
    controller.dispose()

    expect(controller.admitWorker()).toEqual({
      allowed: false,
      code: 'DISPOSED',
      limit: 1,
      observed: 2,
    })
    expect(controller.admitPluginTool('targeted_verify')).toEqual({
      allowed: false,
      code: 'DISPOSED',
      limit: 2,
      observed: 2,
    })
    expect(recorder.values).toEqual([
      { code: 'DISPOSED', limit: 1, observed: 2 },
      { code: 'DISPOSED', limit: 2, observed: 2 },
    ])
  })

  it('isolates counters by root session id and starts fresh after a registry lifecycle ends', () => {
    const recorder = rejections()
    const registry = createBudgetControllerRegistry(budgets, () => recorder.record)
    const rootA = SessionId('budget-root-a')
    const rootB = SessionId('budget-root-b')

    expect(registry.forRootSession(rootA).admitWorker()).toEqual({ allowed: true })
    expect(registry.forRootSession(rootA).admitWorker()).toMatchObject({
      allowed: false,
      code: 'WORKER_LIMIT',
    })
    expect(registry.forRootSession(rootB).admitWorker()).toEqual({ allowed: true })

    registry.disposeSession(rootA)
    expect(registry.forRootSession(rootA).admitWorker()).toEqual({ allowed: true })
  })

  it('removes terminal session state and clears all controllers when its Cordis effect is disposed', async () => {
    const ctx = new Context()
    const sessionStore = await ctx.plugin(SessionStore)
    const recorder = rejections()
    const mounted = mountBudgetControllerRegistry(ctx, budgets, () => recorder.record)
    const session = ctx.sessions.prepare(SessionId('budget-lifecycle'))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)

    const controller = mounted.registry.forRootSession(session.id)
    expect(controller.admitWorker()).toEqual({ allowed: true })
    detach()
    expect(mounted.registry.forRootSession(session.id).admitWorker()).toEqual({ allowed: true })

    await mounted.dispose()
    expect(mounted.registry.forRootSession(session.id).admitWorker()).toEqual({
      allowed: false,
      code: 'DISPOSED',
      limit: 1,
      observed: 1,
    })

    const remounted = mountBudgetControllerRegistry(ctx, budgets, () => recorder.record)
    expect(remounted.registry.forRootSession(session.id).admitWorker()).toEqual({ allowed: true })
    await remounted.dispose()
    await sessionStore.dispose()
  })
})
