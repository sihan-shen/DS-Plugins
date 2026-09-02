import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { BudgetController, parseConfig, resolveSchedule } from '@ds-plugins/dsh-orchestrator'
import { createAdaptiveScheduler, parseAdaptiveSchedulerConfig } from '@ds-plugins/dsh-adaptive-scheduler'
import { replayScheduledDirectFixture } from './direct.fixture.ts'
import { replaySingleWorkerFixture } from './single-worker.fixture.ts'

function loadProfileConfigs() {
  const patch = yaml.load(readFileSync(resolve('profiles/v0.3-adaptive/cordis.patch.yml'), 'utf8')) as Array<{ id: string; config: unknown }>
  const orchestrator = patch.find(entry => entry.id === 'ds-orchestrator')?.config
  const scheduler = patch.find(entry => entry.id === 'dsh-adaptive-scheduler')?.config
  return { orchestrator: parseConfig(orchestrator), scheduler: parseAdaptiveSchedulerConfig(scheduler) }
}

export async function replayAdaptiveScheduling() {
  let now = 1000
  const config = loadProfileConfigs()
  const scheduler = createAdaptiveScheduler(config.scheduler, { now: () => now, generation: 'replay-g1' })
  const controller = new BudgetController(config.orchestrator.budgets, () => undefined)
  const resolver = { current: () => scheduler }
  const workerInput = { target: 'worker' as const, taskId: 'replay-session', objective: 'Fix parser failure', requiredTools: ['targeted_verify'], affinity: { workerId: 'replay-session:worker:1' }, budget: controller.snapshot(), signal: new AbortController().signal }
  const profileFallback = (await resolveSchedule(config.orchestrator, { current: () => undefined }, workerInput)).decision
  const schedulerInput = { ...workerInput, affinity: undefined }
  const schedulerPresentResult = await resolveSchedule(config.orchestrator, resolver, schedulerInput)
  const schedulerPresent = schedulerPresentResult.decision
  const schedulerPresentRequest = schedulerPresentResult.request
  const failedHandoff = { schemaVersion: 1 as const, status: 'failed' as const, summary: 'Replay failure.', changedFiles: [], decisions: [], verification: [], blockers: ['Schema mismatch.'] }

  const invalidController = new BudgetController(config.orchestrator.budgets, () => undefined)
  const before = invalidController.snapshot()
  let invalidError = ''
  try {
    await resolveSchedule(config.orchestrator, { current: () => ({ schedule: async () => ({ schemaVersion: 1, mode: 'single-worker', route: { provider: 'unconfigured', model: 'invalid', maxTokens: 32000 }, workerCount: 1, source: 'scheduler', policyVersion: 'invalid' }) }) }, { ...workerInput, budget: before })
  } catch (error) {
    invalidError = error instanceof Error ? error.message : String(error)
  }

  scheduler.recordFailure({ requestId: 'replay-session', code: 'TIMEOUT' })
  const timeout = (await resolveSchedule(config.orchestrator, resolver, schedulerInput)).decision.route.model
  const cooldown = (await resolveSchedule(config.orchestrator, resolver, schedulerInput)).decision.route.model
  scheduler.recordFailure({ requestId: 'replay-session', code: 'SERVER' })
  const repeated = (await resolveSchedule(config.orchestrator, resolver, schedulerInput)).decision.route.model

  const quotaScheduler = createAdaptiveScheduler(config.scheduler, { now: () => now, generation: 'replay-quota' })
  quotaScheduler.recordFailure({ requestId: 'quota-session', code: 'QUOTA' })
  let quota = ''
  try { await quotaScheduler.schedule({ ...schedulerPresentRequest, taskId: 'quota-session' }, controller.snapshot(), workerInput.signal) }
  catch (error) { quota = error instanceof Error ? error.message : String(error) }

  const handoffScheduler = createAdaptiveScheduler(config.scheduler, { now: () => now, generation: 'replay-handoff' })
  await handoffScheduler.schedule(schedulerPresentRequest, controller.snapshot(), workerInput.signal)
  handoffScheduler.observe?.({ schemaVersion: 1, requestId: 'replay-session', outcome: 'failed', handoff: failedHandoff })
  const handoffEscalation = await handoffScheduler.schedule({ ...schedulerPresentRequest, priorHandoff: failedHandoff }, controller.snapshot(), workerInput.signal)
  const worker = await replaySingleWorkerFixture()
  const root = await replayScheduledDirectFixture()
  now += config.scheduler.escalationTtlMs + 1

  return {
    profileFallback,
    schedulerPresent,
    invalidDecision: { error: invalidError, before, after: invalidController.snapshot() },
    failurePolicy: { quota, timeout, cooldown, repeated },
    handoffEscalation,
    workerEvents: worker.events.filter(event => event.type !== 'dsh-plugin/budget-rejected').map(event => event.type),
    rootEvents: root.events.map(event => event.type),
    directActualRoute: root.actualRoute,
    budgetView: controller.snapshot(),
  }
}
