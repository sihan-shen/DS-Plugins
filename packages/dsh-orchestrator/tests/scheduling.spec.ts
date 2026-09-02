import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  buildCapabilityRequest,
  fixedProfileSchedule,
  mountAdaptiveSchedulerResolver,
  resolveSchedule,
  restoreScheduleSelected,
  scheduleSelectedFrom,
  type ResolveScheduleInput,
} from '../src/scheduling.ts'
import type { OrchestratorConfig } from '../src/types.ts'

const routes = [
  { provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 32_000 },
  { provider: 'provider-disabled', model: 'fallback-disabled', maxTokens: 32_000 },
  { provider: 'provider-disabled', model: 'strong-disabled', maxTokens: 64_000, reasoningEffort: 'high' },
  {
    provider: 'provider-disabled',
    model: 'metadata-disabled',
    maxTokens: 32_000,
    reasoningEffort: 'high',
    promptProfile: 'coding-v1',
    modelFamily: 'deepseek',
  },
] as const

const scheduling = {
  allowInvalidDecisionFallback: false,
  allowedRoutes: routes,
  rootProfile: { coding: 50, reasoning: 50, toolUse: 50, repoContext: 50, risk: 50, difficulty: 50 },
  workerProfile: { coding: 80, reasoning: 70, toolUse: 60, repoContext: 80, risk: 30, difficulty: 60 },
  maxLatencyMs: 60_000,
  allowPaidFallback: false,
} as const

const config: OrchestratorConfig = {
  workspaceRoot: '.',
  mode: 'single-worker',
  worker: { provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 64_000 },
  budgets: { maxWorkers: 1, maxPluginToolActions: 24, toolTimeoutMs: 60_000 },
  verification: { commands: [], timeoutMs: 60_000, maxOutputBytes: 65_536 },
  scheduling,
}

const workerInput: ResolveScheduleInput = {
  target: 'worker',
  taskId: 'session-1',
  objective: 'Fix the scheduling adapter',
  requiredTools: ['targeted_verify'],
  affinity: { workerId: 'session-1:worker:1' },
  budget: {
    maxWorkers: 1,
    admittedWorkers: 0,
    maxPluginToolActions: 24,
    admittedPluginToolActions: 0,
    remainingWorkers: 1,
    remainingPluginToolActions: 24,
  },
  signal: new AbortController().signal,
}

const validDecision = {
  schemaVersion: 1,
  mode: 'single-worker',
  route: routes[0],
  workerCount: 1,
  source: 'scheduler',
  policyVersion: 'v0.3.0',
  explanationCode: 'TASK_BASELINE',
} as const

const validSelectedEvent = {
  schemaVersion: 1,
  target: 'root',
  source: 'scheduler',
  provider: 'provider-disabled',
  model: 'baseline-disabled',
  maxTokens: 32_000,
  policyVersion: 'v0.3.0',
} as const

describe('orchestrator scheduling adapter', () => {
  it('projects a bounded capability request from the target and deployment policy', () => {
    expect(buildCapabilityRequest(config, workerInput)).toEqual({
      schemaVersion: 1,
      target: 'worker',
      taskId: 'session-1',
      objective: 'Fix the scheduling adapter',
      profile: scheduling.workerProfile,
      constraints: {
        maxWorkers: 1,
        maxOutputTokens: 64_000,
        maxLatencyMs: 60_000,
        allowPaidFallback: false,
        allowedProviders: ['provider-disabled'],
        requiredTools: ['targeted_verify'],
      },
      affinity: { workerId: 'session-1:worker:1' },
    })
  })

  it('uses the fixed worker route when the optional scheduler is absent', async () => {
    const resolver = { current: () => undefined }
    await expect(resolveSchedule(config, resolver, workerInput)).resolves.toMatchObject({
      decision: { source: 'profile-fallback', route: config.worker },
    })
  })

  it('accepts a valid scheduler response and returns its selected route', async () => {
    const scheduler = { schedule: async () => validDecision }
    await expect(resolveSchedule(config, { current: () => scheduler }, workerInput)).resolves.toMatchObject({
      decision: validDecision,
      scheduler,
    })
  })

  it('tracks an optional adaptive scheduler service without making it required', () => {
    const ctx = new Context()
    expect(ctx.get('adaptiveScheduler')).toBeUndefined()
    const mounted = mountAdaptiveSchedulerResolver(ctx)
    expect(mounted.current()).toBeUndefined()
    const fakeScheduler = { schedule: async () => validDecision }
    const dispose = ctx.provide('adaptiveScheduler', fakeScheduler as never)
    expect(mounted.current()).toBe(fakeScheduler)
    dispose()
    expect(mounted.current()).toBeUndefined()
  })

  it('rejects an invalid scheduler route without consuming the supplied budget', async () => {
    const beforeBudget = workerInput.budget
    const invalid = { ...validDecision, route: { ...validDecision.route, provider: 'not-configured' } }
    await expect(resolveSchedule(config, {
      current: () => ({ schedule: async () => invalid }),
    }, workerInput)).rejects.toThrow('SCHEDULE_DECISION_INVALID')
    expect(workerInput.budget).toEqual(beforeBudget)
  })

  it('falls back to the fixed profile only when invalid-decision fallback is enabled', async () => {
    const invalid = { ...validDecision, route: { ...validDecision.route, provider: 'not-configured' } }
    await expect(resolveSchedule({
      ...config,
      scheduling: { ...scheduling, allowInvalidDecisionFallback: true },
    }, {
      current: () => ({ schedule: async () => invalid }),
    }, workerInput)).resolves.toMatchObject({
      decision: { source: 'profile-fallback', route: config.worker },
    })
  })

  it('does not fall back to the fixed profile when cancellation races with invalid scheduling', async () => {
    const cancellation = new Error('cancelled while scheduling')
    const aborted = new AbortController()
    let release: (() => void) | undefined
    const pending = resolveSchedule({
      ...config,
      scheduling: { ...scheduling, allowInvalidDecisionFallback: true },
    }, {
      current: () => ({
        schedule: async () => new Promise(resolve => {
          release = () => resolve({
            ...validDecision,
            route: { ...validDecision.route, provider: 'not-configured' },
          })
        }),
      }),
    }, { ...workerInput, signal: aborted.signal })

    await Promise.resolve()
    aborted.abort(cancellation)
    release?.()

    await expect(pending).rejects.toBe(cancellation)
  })

  it.each([
    ['reasoningEffort', 'low'],
    ['promptProfile', 'review-v1'],
    ['modelFamily', 'other-family'],
  ] as const)('rejects a scheduler response with mismatched %s route metadata', async (field, value) => {
    const metadataRoute = routes[3]
    const invalid = {
      ...validDecision,
      route: { ...metadataRoute, [field]: value },
    }
    await expect(resolveSchedule(config, {
      current: () => ({ schedule: async () => invalid }),
    }, workerInput)).rejects.toThrow('SCHEDULE_DECISION_INVALID')
  })

  it('converts decisions into provenance events and restores only configured routes', () => {
    expect(scheduleSelectedFrom(validDecision, 'worker')).toMatchObject({
      target: 'worker',
      source: 'scheduler',
      provider: 'provider-disabled',
      model: 'baseline-disabled',
      maxTokens: 32_000,
      policyVersion: 'v0.3.0',
    })

    const restored = restoreScheduleSelected([
      { type: 'dsh-plugin/schedule-selected', data: validSelectedEvent } as SessionEvent,
    ], { ...config, mode: 'direct', budgets: { ...config.budgets, maxWorkers: 0 } }, 'root')
    expect(restored).toMatchObject({
      source: 'scheduler',
      route: { provider: 'provider-disabled', model: 'baseline-disabled' },
      explanationCode: 'DURABLE_STICKY_RESTORE',
    })
    expect(restoreScheduleSelected([
      { type: 'dsh-plugin/schedule-selected', data: { ...validSelectedEvent, model: 'not-configured' } } as SessionEvent,
    ], config, 'root')).toBeUndefined()
  })

  it('rejects durable selections when scheduling policy is absent', () => {
    const noSchedulingConfig: OrchestratorConfig = {
      ...config,
      mode: 'direct',
      budgets: { ...config.budgets, maxWorkers: 0 },
      scheduling: undefined,
    }
    expect(restoreScheduleSelected([
      {
        type: 'dsh-plugin/schedule-selected',
        data: { ...validSelectedEvent, provider: 'unconfigured', model: 'unconfigured', target: 'root' },
      } as SessionEvent,
    ], noSchedulingConfig, 'root')).toBeUndefined()
  })

  it('rejects durable selections that omit configured route metadata', () => {
    const metadataConfig: OrchestratorConfig = {
      ...config,
      mode: 'direct',
      budgets: { ...config.budgets, maxWorkers: 0 },
      scheduling: { ...scheduling, allowedRoutes: [routes[3]] },
    }
    expect(restoreScheduleSelected([
      {
        type: 'dsh-plugin/schedule-selected',
        data: {
          ...validSelectedEvent,
          provider: routes[3].provider,
          model: routes[3].model,
          maxTokens: routes[3].maxTokens,
          reasoningEffort: routes[3].reasoningEffort,
          promptProfile: routes[3].promptProfile,
          target: 'root',
        },
      } as SessionEvent,
    ], metadataConfig, 'root')).toBeUndefined()
  })

  it('rejects target-incompatible fixed profiles', () => {
    expect(() => fixedProfileSchedule(config.worker, config.mode, 'root')).toThrow()
  })
})
