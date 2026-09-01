import { parseBudgetViewV1, parseCapabilityRequestV1, parseScheduleDecisionV1 } from '@ds-plugins/dsh-scheduling-contracts'
import type { BudgetViewV1, CapabilityRequestV1, ScheduleDecisionV1 } from '@ds-plugins/dsh-scheduling-contracts'
import { classifyTaskType, resolveCatalogCandidate, strongestAllowedAlias } from './catalog.js'
import type { AdaptiveSchedulerConfig, AdaptiveSchedulerRuntime, RouteCatalogEntryV1, SchedulerOptions, TaskTypeV1 } from './types.js'

export class SchedulingError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'SchedulingError'; this.code = code }
}

const ALLOWED_TOOLS = new Set(['targeted_verify'])

interface Selection {
  readonly candidate: RouteCatalogEntryV1
  readonly reason: string
  readonly taskType: TaskTypeV1
}

function baselineSelection(config: AdaptiveSchedulerConfig, request: CapabilityRequestV1): Selection {
  if (request.constraints.requiredTools.some(tool => !ALLOWED_TOOLS.has(tool))) throw new SchedulingError('SAFETY_GATE')
  if (request.target === 'worker' && request.constraints.maxWorkers === 0) throw new SchedulingError('SAFETY_GATE')
  if (request.target === 'worker' && request.constraints.requiredTools.includes('delegate_worker')) throw new SchedulingError('SAFETY_GATE')
  const taskType = classifyTaskType(request)
  const explicitAlias = config.explicitRoutes?.[request.target]
  const highImpactAlias = explicitAlias === undefined && request.profile.risk >= 80 ? strongestAllowedAlias(config, request) : undefined
  const alias = explicitAlias ?? highImpactAlias ?? config.baselines[taskType]
  const candidate = resolveCatalogCandidate(config, alias, request)
  if (candidate === undefined) throw new SchedulingError('NO_CATALOG_ROUTE')
  const reason = explicitAlias !== undefined ? 'EXPLICIT_ROUTE' : highImpactAlias !== undefined ? 'HIGH_IMPACT_STRONG_ROUTE' : 'TASK_BASELINE'
  return { candidate, reason, taskType }
}

export function createAdaptiveScheduler(config: AdaptiveSchedulerConfig, options: SchedulerOptions = {}): AdaptiveSchedulerRuntime {
  const generation = options.generation ?? 'default'
  return {
    generation,
    async schedule(requestValue: CapabilityRequestV1, budgetValue: BudgetViewV1, signal: AbortSignal): Promise<ScheduleDecisionV1> {
      const request = parseCapabilityRequestV1(requestValue)
      const budget = parseBudgetViewV1(budgetValue)
      if (signal.aborted) throw signal.reason ?? new DOMException('Scheduling cancelled', 'AbortError')
      if (request.target === 'worker' && budget.remainingWorkers < 1) throw new SchedulingError('LOCAL_WORKER_BUDGET')
      if (budget.remainingPluginToolActions < 1) throw new SchedulingError('LOCAL_TOOL_BUDGET')
      const selected = baselineSelection(config, request)
      return parseScheduleDecisionV1({
        schemaVersion: 1,
        mode: request.target === 'worker' ? 'single-worker' : 'direct',
        route: selected.candidate.route,
        workerCount: request.target === 'worker' ? 1 : 0,
        source: 'scheduler',
        policyVersion: config.policyVersion,
        affinityKey: `${request.taskId}:${request.target}:${generation}:${selected.candidate.alias}`,
        explanationCode: selected.reason,
      })
    },
  }
}
