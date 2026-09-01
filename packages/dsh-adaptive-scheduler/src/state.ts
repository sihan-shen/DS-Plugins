import type { CapabilityRequestV1, RouteDecisionV1 } from '@ds-plugins/dsh-scheduling-contracts'
import type { AdaptiveSchedulerConfig, ProviderFailureFactV1, RouteSwitchRecordV1, StickyRouteStateV1, WorkerAffinityStateV1, RouteCatalogEntryV1 } from './types.js'

interface FailureRecordV1 extends ProviderFailureFactV1 {
  readonly at: number
}

interface EscalationStateV1 {
  readonly count: number
  readonly expiresAt: number
}

function requestKey(request: Pick<CapabilityRequestV1, 'taskId' | 'target'>): string {
  return `${request.taskId}:${request.target}`
}

function freezeRoute(route: RouteDecisionV1): RouteDecisionV1 {
  return Object.freeze({ ...route })
}

export class SchedulerStateStore {
  private readonly sticky = new Map<string, StickyRouteStateV1>()
  private readonly affinity = new Map<string, WorkerAffinityStateV1>()
  private readonly failures = new Map<string, readonly FailureRecordV1[]>()
  private readonly selectedFailureCounts = new Map<string, number>()
  private readonly escalations = new Map<string, EscalationStateV1>()
  private readonly routeSwitches: RouteSwitchRecordV1[] = []

  constructor(private readonly config: AdaptiveSchedulerConfig) {}

  peekSticky(request: CapabilityRequestV1, generation: string): StickyRouteStateV1 | undefined {
    const state = this.sticky.get(requestKey(request))
    return state?.generation === generation ? state : undefined
  }

  takeSticky(request: CapabilityRequestV1, now: number, generation: string): StickyRouteStateV1 | undefined {
    const key = requestKey(request)
    const state = this.sticky.get(key)
    if (state === undefined || state.generation !== generation || now > state.expiresAt || now > state.idleExpiresAt) {
      this.sticky.delete(key)
      this.selectedFailureCounts.delete(key)
      return undefined
    }
    const refreshed = Object.freeze({ ...state, lastUsedAt: now, idleExpiresAt: now + this.config.idleTtlMs })
    this.sticky.set(key, refreshed)
    return refreshed
  }

  rememberSticky(request: CapabilityRequestV1, alias: string, now: number, generation: string, failureCount: number): StickyRouteStateV1 {
    const key = requestKey(request)
    const state = Object.freeze({
      requestId: request.taskId,
      phase: request.target,
      generation,
      alias,
      selectedAt: now,
      lastUsedAt: now,
      expiresAt: now + this.config.stickyTtlMs,
      idleExpiresAt: now + this.config.idleTtlMs,
    })
    this.sticky.set(key, state)
    this.selectedFailureCounts.set(key, failureCount)
    return state
  }

  clearSticky(request: Pick<CapabilityRequestV1, 'taskId' | 'target'>): void {
    const key = requestKey(request)
    this.sticky.delete(key)
    this.selectedFailureCounts.delete(key)
  }

  failuresFor(requestId: string, now: number): readonly FailureRecordV1[] {
    const active = (this.failures.get(requestId) ?? []).filter(failure => now - failure.at <= this.config.errorWindowMs)
    this.failures.set(requestId, active)
    return active
  }

  recordFailure(fact: ProviderFailureFactV1, now: number): void {
    const records = [...(this.failures.get(fact.requestId) ?? []), Object.freeze({ ...fact, at: now })]
    const bounded = records.slice(-this.config.historyWindowSize)
    this.failures.set(fact.requestId, Object.freeze(bounded))
  }

  failuresSinceSelection(request: CapabilityRequestV1, state: StickyRouteStateV1, now: number): number {
    const selectedCount = this.selectedFailureCounts.get(requestKey(request)) ?? 0
    return Math.max(0, this.failuresFor(request.taskId, now).length - selectedCount)
  }

  escalation(requestId: string, now: number): EscalationStateV1 | undefined {
    const state = this.escalations.get(requestId)
    if (state === undefined) return undefined
    if (now > state.expiresAt) {
      this.escalations.delete(requestId)
      return undefined
    }
    return state
  }

  peekEscalation(requestId: string): EscalationStateV1 | undefined {
    return this.escalations.get(requestId)
  }

  markEscalation(requestId: string, now: number): EscalationStateV1 {
    const previous = this.escalations.get(requestId)
    const state = Object.freeze({ count: (previous?.count ?? 0) + 1, expiresAt: now + this.config.escalationTtlMs })
    this.escalations.set(requestId, state)
    return state
  }

  clearEscalation(request: Pick<CapabilityRequestV1, 'taskId' | 'target'>): void {
    this.escalations.delete(request.taskId)
    this.clearSticky(request)
    this.failures.delete(request.taskId)
  }

  freezeAffinity(request: CapabilityRequestV1, candidate: RouteCatalogEntryV1, generation: string): WorkerAffinityStateV1 | undefined {
    const workerId = request.affinity?.workerId
    if (request.target !== 'worker' || workerId === undefined) return undefined
    const state = Object.freeze({
      workerId,
      requestId: request.taskId,
      generation,
      alias: candidate.alias,
      toolFilter: Object.freeze([...candidate.toolFilter]),
      maxDepth: 1 as const,
      outputSchema: 'handoff-v1' as const,
      maxTokens: candidate.route.maxTokens,
      background: false as const,
    })
    this.affinity.set(workerId, state)
    return state
  }

  affinityFor(workerId: string, generation: string): WorkerAffinityStateV1 | undefined {
    const state = this.affinity.get(workerId)
    return state?.generation === generation ? state : undefined
  }

  complete(requestId: string): void {
    for (const [workerId, state] of this.affinity) if (state.requestId === requestId) this.affinity.delete(workerId)
  }

  recordSwitch(record: RouteSwitchRecordV1): void {
    const frozen = Object.freeze({
      ...record,
      ...(record.previousRoute === undefined ? {} : { previousRoute: freezeRoute(record.previousRoute) }),
      nextRoute: freezeRoute(record.nextRoute),
    })
    this.routeSwitches.push(frozen)
    if (this.routeSwitches.length > 64) this.routeSwitches.shift()
  }

  switches(): readonly RouteSwitchRecordV1[] {
    return Object.freeze([...this.routeSwitches])
  }
}
