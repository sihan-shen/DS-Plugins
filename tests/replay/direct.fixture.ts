import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createBudgetControllerRegistry } from '../../packages/dsh-orchestrator/src/budgets.ts'
import { mountDirectMode } from '../../packages/dsh-orchestrator/src/direct.ts'
import { mountRootScheduling } from '../../packages/dsh-orchestrator/src/scheduling.ts'
import { createTargetedVerificationTool } from '../../packages/dsh-orchestrator/src/verification.ts'
import type { OrchestratorConfig, RequestRouteV1, VerificationEvidenceV1 } from '../../packages/dsh-orchestrator/src/types.ts'

const config: OrchestratorConfig = {
  workspaceRoot: '/workspace/dsh',
  mode: 'direct',
  worker: { provider: 'replay', model: 'replay', maxTokens: 32_000 },
  budgets: { maxWorkers: 0, maxPluginToolActions: 8, toolTimeoutMs: 60_000 },
  verification: {
    commands: [{ name: 'typecheck', executable: 'pnpm', fixedArgs: ['typecheck'], allowedArgs: 'none' }],
    timeoutMs: 8,
    maxOutputBytes: 8,
  },
}

interface ReplayHandle {
  readonly done: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>
  readonly collected: {
    readonly stdout: { readFrom(offset: number): { text: string; lossy: boolean } }
    readonly stderr: { readFrom(offset: number): { text: string; lossy: boolean } }
  }
  terminate(): void
  waitForExit(): Promise<boolean>
}

function handle(
  done: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>,
  stdout = '',
  stderr = '',
): ReplayHandle {
  return {
    done,
    collected: {
      stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
      stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
    },
    terminate: () => undefined,
    waitForExit: async () => true,
  }
}

function evidenceProjection(evidence: VerificationEvidenceV1) {
  return {
    commandName: evidence.commandName,
    args: evidence.args,
    exitCode: evidence.exitCode,
    status: evidence.status,
    stdout: evidence.stdout,
    stderr: evidence.stderr,
    truncated: evidence.truncated,
  }
}

function createSession(id: string): Session {
  return Session.create(SessionId(id), undefined, {
    version: 0,
    id: SessionId(id),
    createdAt: 0,
    cwd: config.workspaceRoot,
  })
}

async function executeTargetedVerify(id: string, spawn: (signal: AbortSignal) => ReplayHandle) {
  const session = createSession(id)
  const tool = createTargetedVerificationTool({
    workspaceRoot: config.workspaceRoot,
    verification: config.verification,
    subprocess: {
      spawn: ({ signal }: { readonly signal: AbortSignal }) => spawn(signal),
    } as never,
    budgetRegistry: createBudgetControllerRegistry(config.budgets, () => () => undefined),
  })
  const evidence = await tool.execute(
    { command: 'typecheck', args: [] },
    { signal: new AbortController().signal, agent: { session } } as never,
  ) as VerificationEvidenceV1
  return {
    evidence: evidenceProjection(evidence),
    events: session.events.map(event => ({ type: event.type, data: event.data })),
  }
}

/** Execute a keyless Direct verification turn and retain only canonical evidence. */
export async function replayDirectFixture() {
  return executeTargetedVerify(
    'replay-direct',
    () => handle(Promise.resolve({ exitCode: 0, signal: null }), 'typecheck passed'),
  )
}

/** Exercise every non-passing verification normalization through the registered tool path. */
export async function replayVerificationVariants() {
  return {
    failed: await executeTargetedVerify(
      'replay-failed',
      () => handle(Promise.resolve({ exitCode: 1, signal: null }), '', 'typecheck failed'),
    ),
    'timed-out': await executeTargetedVerify(
      'replay-timed-out',
      signal => handle(new Promise(resolve => {
        signal.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })
      })),
    ),
    'spawn-error': await executeTargetedVerify(
      'replay-spawn-error',
      () => handle(Promise.reject(new Error('spawn unavailable'))),
    ),
    truncated: await executeTargetedVerify(
      'replay-truncated',
      () => handle(Promise.resolve({ exitCode: 0, signal: null }), '0123456789'),
    ),
  }
}

/** Run the scheduled Direct root seam and retain the actual request route only. */
export async function replayScheduledDirectFixture(): Promise<{
  readonly events: readonly SessionEvent[]
  readonly actualRoute: RequestRouteV1
}> {
  const ctx = new Context()
  const sessionStore = await ctx.plugin(SessionStore)
  ctx.provide('systemPrompt', {
    section: () => () => undefined,
  } as never)
  const directConfig: OrchestratorConfig = {
    workspaceRoot: '/workspace/dsh',
    mode: 'direct',
    worker: { provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 64_000 },
    budgets: { maxWorkers: 0, maxPluginToolActions: 24, toolTimeoutMs: 60_000 },
    verification: { commands: [], timeoutMs: 60_000, maxOutputBytes: 65_536 },
    scheduling: {
      allowInvalidDecisionFallback: false,
      allowedRoutes: [{ provider: 'provider-disabled', model: 'strong-disabled', maxTokens: 64_000, reasoningEffort: 'high' }],
      rootProfile: { coding: 50, reasoning: 50, toolUse: 50, repoContext: 50, risk: 50, difficulty: 50 },
      workerProfile: { coding: 80, reasoning: 70, toolUse: 60, repoContext: 80, risk: 30, difficulty: 60 },
      maxLatencyMs: 60_000,
      allowPaidFallback: false,
    },
  }
  const budgetRegistry = createBudgetControllerRegistry(directConfig.budgets, () => () => undefined)
  const scheduler = {
    schedule: async () => ({
      schemaVersion: 1 as const,
      mode: 'direct' as const,
      route: { provider: 'provider-disabled', model: 'strong-disabled', maxTokens: 64_000, reasoningEffort: 'high' },
      workerCount: 0 as const,
      source: 'scheduler' as const,
      policyVersion: 'v0.3.0',
    }),
  }
  mountDirectMode(ctx, directConfig)
  mountRootScheduling(ctx, directConfig, budgetRegistry, { current: () => scheduler })

  const root = ctx.sessions.create(SessionId('replay-scheduled-direct'), { meta: { cwd: directConfig.workspaceRoot } })
  const agent = { id: root.id, session: root } as Agent
  await agentEvents(ctx, agent).waterfall(
    'agent/request',
    { turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ provider: 'profile-disabled', model: 'profile-disabled' }),
  )
  root.append('request/header', {
    header: { config: { provider: 'actual-disabled', model: 'actual-model-disabled' } },
    reason: 'initial',
  })
  await Promise.resolve()

  const events = root.events
  const actualRoute = { provider: 'actual-disabled', model: 'actual-model-disabled' }
  await sessionStore.dispose()
  return { events, actualRoute }
}
