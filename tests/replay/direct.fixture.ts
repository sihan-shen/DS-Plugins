import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createBudgetControllerRegistry } from '../../packages/dsh-orchestrator/src/budgets.ts'
import { createTargetedVerificationTool } from '../../packages/dsh-orchestrator/src/verification.ts'
import type { OrchestratorConfig, VerificationEvidenceV1 } from '../../packages/dsh-orchestrator/src/types.ts'

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
