import type { AdaptiveSchedulerService, RouteDecisionV1 } from '@ds-plugins/dsh-scheduling-contracts'

export type TaskTypeV1 = 'code-fix' | 'code-new' | 'research' | 'summarize' | 'review' | 'tool-heavy' | 'unknown'
export type RouteTierV1 = 'baseline' | 'fallback' | 'strong'

export interface RouteCatalogEntryV1 {
  readonly alias: string
  readonly route: RouteDecisionV1
  readonly tier: RouteTierV1
  readonly taskTypes: readonly TaskTypeV1[]
  readonly toolFilter: readonly string[]
  readonly paid: boolean
  readonly reliability: number
}

export interface AdaptiveSchedulerConfig {
  readonly policyVersion: string
  readonly catalog: readonly RouteCatalogEntryV1[]
  readonly baselines: Readonly<Record<TaskTypeV1, string>>
  readonly explicitRoutes?: { readonly root?: string; readonly worker?: string }
  readonly stickyTtlMs: number
  readonly idleTtlMs: number
  readonly errorWindowMs: number
  readonly cooldownMs: number
  readonly escalationTtlMs: number
  readonly maxEscalationsPerTask: number
  readonly maxRounds: number
  readonly historyWindowSize: number
  readonly historyMinSamples: number
}

export interface SchedulerOptions {
  readonly now?: () => number
  readonly generation?: string
}

export interface CatalogAvailabilityV1 {
  readonly quota: 'unknown'
  readonly price: 'unknown'
  readonly health: 'unknown'
}

export interface AdaptiveSchedulerRuntime extends AdaptiveSchedulerService {
  readonly generation: string
}
