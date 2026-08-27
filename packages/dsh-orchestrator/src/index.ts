import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-tools'
import { mountBudgetControllerRegistry } from './budgets.js'
import { Config } from './config.js'
import { mountDirectMode } from './direct.js'
import { appendBudgetRejected } from './events.js'
import { mountTargetedVerificationTool } from './verification.js'
import { mountSingleWorkerMode } from './worker.js'
import type { OrchestratorConfig } from './types.js'

export { BudgetController, createBudgetControllerRegistry, mountBudgetControllerRegistry } from './budgets.js'
export type {
  BudgetAllowed,
  BudgetControllerRegistry,
  BudgetDecision,
  BudgetRejected,
  BudgetRejection,
  BudgetRejectionCode,
  BudgetRejectionRecorder,
  BudgetRejectionRecorderFactory,
  MountedBudgetControllerRegistry,
  PluginToolAction,
} from './budgets.js'
export { Config, parseConfig } from './config.js'
export { DIRECT_PROMPT_ORDER, DIRECT_PROMPT_SECTION, mountDirectMode } from './direct.js'
export {
  appendBudgetRejected,
  appendRunStarted,
  appendVerificationFinished,
  appendWorkerFinished,
  appendWorkerRequested,
} from './events.js'
export type {
  BudgetRejectedInput,
  BudgetRejectedV1,
  RunStartedInput,
  RunStartedV1,
  WorkerFinishedV1,
} from './events.js'
export { failedHandoff, normalizeWorkerOutput, parseHandoff } from './handoff.js'
export {
  createTargetedVerificationTool,
  mountTargetedVerificationTool,
  VerificationService,
  VERIFICATION_CLEANUP_ALLOWANCE_MS,
  VERIFICATION_TERMINATION_GRACE_MS,
} from './verification.js'
export {
  createDelegateWorkerTool,
  HANDOFF_V1_JSON_SCHEMA,
  mountSingleWorkerMode,
  parseDelegateWorkerInput,
  runWorker,
} from './worker.js'
export type {
  DelegateWorkerInput,
  DelegateWorkerToolOptions,
  RunWorkerOptions,
} from './worker.js'
export type {
  TargetedVerificationToolOptions,
  VerificationEvidenceAppender,
  VerificationServiceOptions,
} from './verification.js'
export type {
  HandoffV1,
  OrchestratorConfig,
  VerificationCommand,
  VerificationEvidenceV1,
  WorkerSpecV1,
} from './types.js'

/** Stable Cordis plugin name for the DSH v0.1 orchestration bundle. */
export const name = 'ds-orchestrator'

/** Required services for the v0.1 Direct runtime. */
export const inject = ['systemPrompt', 'tools', 'sessions', 'subagents', 'subprocess']

/**
 * Mount the v0.1 bundle entry point.
 * @param ctx - Cordis context that owns session lifecycle and teardown.
 * @param config - Validated deployment configuration whose budget limits are enforced.
 */
export function apply(ctx: Context, config: OrchestratorConfig): void {
  const budgets = mountBudgetControllerRegistry(ctx, config.budgets, rootSessionId => rejection => {
    const session = ctx.sessions.get(rootSessionId)
    if (session === undefined) return
    appendBudgetRejected(session, {
      reason: rejection.code,
      limit: rejection.limit,
      observed: rejection.observed,
    })
  })
  mountTargetedVerificationTool(ctx, {
    workspaceRoot: config.workspaceRoot,
    verification: config.verification,
    subprocess: ctx.subprocess,
    budgetRegistry: budgets.registry,
  })
  if (config.mode === 'direct') {
    mountDirectMode(ctx, config)
  } else {
    mountSingleWorkerMode(ctx, config, budgets.registry)
  }
}

apply.Config = Config
apply.inject = inject
