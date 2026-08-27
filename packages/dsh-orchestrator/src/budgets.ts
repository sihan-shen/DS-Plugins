import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { OrchestratorConfig } from './types.js'

/** The only plugin-owned tools counted by the v0.1 action budget. */
export type PluginToolAction = 'delegate_worker' | 'targeted_verify'

/** Stable reasons for a rejected admission. */
export type BudgetRejectionCode = 'WORKER_LIMIT' | 'PLUGIN_TOOL_LIMIT' | 'DISPOSED'

/** One admitted operation. */
export interface BudgetAllowed {
  readonly allowed: true
}

/** One rejected operation, with the first counter value that would exceed its limit. */
export interface BudgetRejected {
  readonly allowed: false
  readonly code: BudgetRejectionCode
  readonly limit: number
  readonly observed: number
}

/** The result of synchronously admitting one plugin-owned operation. */
export type BudgetDecision = BudgetAllowed | BudgetRejected

/** The durable fields recorded for one admission rejection. */
export type BudgetRejection = Omit<BudgetRejected, 'allowed'>

/** Receives each budget rejection while its owning plugin effect is live. */
export type BudgetRejectionRecorder = (rejection: BudgetRejection) => void

/** Creates the rejection recorder for a specific root session. */
export type BudgetRejectionRecorderFactory = (rootSessionId: SessionId) => BudgetRejectionRecorder

const pluginToolActions = new Set<PluginToolAction>(['delegate_worker', 'targeted_verify'])
const ignoredRejection: BudgetRejectionRecorder = () => undefined

function assertPluginToolAction(action: string): asserts action is PluginToolAction {
  if (!pluginToolActions.has(action as PluginToolAction)) {
    throw new TypeError(`unknown plugin tool action: ${JSON.stringify(action)}`)
  }
}

/**
 * Synchronously admits the bounded operations owned by one root session.
 * @param budgets - Validated deployment limits for this session.
 * @param recordRejection - Durable-event recorder called once for every rejected admission.
 */
export class BudgetController {
  private readonly workerLimit: number
  private readonly pluginToolActionLimit: number
  private workerCount = 0
  private pluginToolActionCount = 0
  private disposed = false

  constructor(budgets: OrchestratorConfig['budgets'], private readonly recordRejection: BudgetRejectionRecorder) {
    this.workerLimit = budgets.maxWorkers
    this.pluginToolActionLimit = budgets.maxPluginToolActions
  }

  /**
   * Admit the next plugin-owned worker without allowing a rejected attempt to mutate its counter.
   * @returns an allowed decision, or a stable worker-limit/disposed rejection.
   */
  admitWorker(): BudgetDecision {
    if (this.disposed) return this.reject('DISPOSED', this.workerLimit, this.workerCount + 1)
    const observed = this.workerCount + 1
    if (observed > this.workerLimit) return this.reject('WORKER_LIMIT', this.workerLimit, observed)
    this.workerCount = observed
    return { allowed: true }
  }

  /**
   * Admit the next registered plugin tool action without counting unknown or rejected actions.
   * @param action - One v0.1 plugin-owned tool name.
   * @returns an allowed decision, or a stable tool-limit/disposed rejection.
   * @throws {TypeError} When `action` is not a registered v0.1 plugin tool.
   */
  admitPluginTool(action: PluginToolAction): BudgetDecision {
    assertPluginToolAction(action)
    if (this.disposed) return this.reject('DISPOSED', this.pluginToolActionLimit, this.pluginToolActionCount + 1)
    const observed = this.pluginToolActionCount + 1
    if (observed > this.pluginToolActionLimit) {
      return this.reject('PLUGIN_TOOL_LIMIT', this.pluginToolActionLimit, observed)
    }
    this.pluginToolActionCount = observed
    return { allowed: true }
  }

  /** Dispose this controller so every later admission fails without changing counters. */
  dispose(): void {
    this.disposed = true
  }

  private reject(code: BudgetRejectionCode, limit: number, observed: number): BudgetRejected {
    const rejection = { code, limit, observed }
    this.recordRejection(rejection)
    return { allowed: false, ...rejection }
  }
}

/** Session-scoped controller lookup and lifecycle operations. */
export interface BudgetControllerRegistry {
  /** Return the controller isolated to one root session id. */
  forRootSession(rootSessionId: SessionId): BudgetController
  /** Dispose and remove a root session controller after its terminal lifecycle. */
  disposeSession(rootSessionId: SessionId): void
  /** Dispose all controllers when the owning plugin effect ends. */
  dispose(): void
}

class SessionBudgetControllerRegistry implements BudgetControllerRegistry {
  private readonly controllers = new Map<SessionId, BudgetController>()
  private disposed = false

  constructor(
    private readonly budgets: OrchestratorConfig['budgets'],
    private readonly recorderFor: BudgetRejectionRecorderFactory,
  ) {}

  forRootSession(rootSessionId: SessionId): BudgetController {
    if (this.disposed) return this.disposedController()
    let controller = this.controllers.get(rootSessionId)
    if (controller === undefined) {
      controller = new BudgetController(this.budgets, this.recorderFor(rootSessionId))
      this.controllers.set(rootSessionId, controller)
    }
    return controller
  }

  disposeSession(rootSessionId: SessionId): void {
    const controller = this.controllers.get(rootSessionId)
    controller?.dispose()
    this.controllers.delete(rootSessionId)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const controller of this.controllers.values()) controller.dispose()
    this.controllers.clear()
  }

  private disposedController(): BudgetController {
    const controller = new BudgetController(this.budgets, ignoredRejection)
    controller.dispose()
    return controller
  }
}

/**
 * Create a registry whose controllers are isolated by root session id.
 * @param budgets - Validated deployment limits shared by each isolated controller.
 * @param recorderFor - Creates the durable rejection recorder for each root session.
 * @returns the session-scoped budget registry.
 */
export function createBudgetControllerRegistry(
  budgets: OrchestratorConfig['budgets'],
  recorderFor: BudgetRejectionRecorderFactory,
): BudgetControllerRegistry {
  return new SessionBudgetControllerRegistry(budgets, recorderFor)
}

/** A registry installed in a Cordis effect with its effect disposer. */
export interface MountedBudgetControllerRegistry {
  readonly registry: BudgetControllerRegistry
  readonly dispose: () => Promise<void>
}

/**
 * Mount session-terminal cleanup and effect teardown for one budget registry.
 * @param ctx - Cordis plugin context that owns the registry lifetime.
 * @param budgets - Validated deployment limits for each root session.
 * @param recorderFor - Creates the durable rejection recorder for each root session.
 * @returns the mounted registry and its HMR-safe effect disposer.
 */
export function mountBudgetControllerRegistry(
  ctx: Context,
  budgets: OrchestratorConfig['budgets'],
  recorderFor: BudgetRejectionRecorderFactory,
): MountedBudgetControllerRegistry {
  const registry = createBudgetControllerRegistry(budgets, recorderFor)
  const dispose = ctx.effect(function* () {
    yield () => registry.dispose()
    yield ctx.on('session/disposed', session => { registry.disposeSession(session.id) })
  }, 'ds-orchestrator: budget controllers')
  return { registry, dispose }
}
