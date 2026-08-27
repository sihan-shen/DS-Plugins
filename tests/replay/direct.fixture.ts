import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createBudgetControllerRegistry } from '../../packages/dsh-orchestrator/src/budgets.ts'
import { createTargetedVerificationTool, VerificationService } from '../../packages/dsh-orchestrator/src/verification.ts'
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

/** Execute a keyless Direct verification turn and retain only canonical evidence. */
export async function replayDirectFixture() {
  const session = Session.create(SessionId('replay-direct'), undefined, {
    version: 0,
    id: SessionId('replay-direct'),
    createdAt: 0,
    cwd: config.workspaceRoot,
  })
  const tool = createTargetedVerificationTool({
    workspaceRoot: config.workspaceRoot,
    verification: config.verification,
    subprocess: {
      spawn: () => handle(Promise.resolve({ exitCode: 0, signal: null }), 'typecheck passed'),
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

/** Exercise every non-passing verification normalization without an LLM provider. */
export async function replayVerificationVariants() {
  const outcomes: Record<string, VerificationEvidenceV1> = {}
  const run = async (name: string, spawn: (signal: AbortSignal) => ReplayHandle) => {
    const service = new VerificationService({
      workspaceRoot: config.workspaceRoot,
      verification: config.verification,
      subprocess: { spawn: ({ signal }: { readonly signal: AbortSignal }) => spawn(signal) } as never,
      appendEvidence: () => undefined,
    })
    outcomes[name] = await service.run('typecheck', [], new AbortController().signal)
  }

  await run('failed', () => handle(Promise.resolve({ exitCode: 1, signal: null }), '', 'typecheck failed'))
  await run('timed-out', signal => handle(new Promise(resolve => {
    signal.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })
  })))
  await run('spawn-error', () => handle(Promise.reject(new Error('spawn unavailable'))))
  await run('truncated', () => handle(Promise.resolve({ exitCode: 0, signal: null }), '0123456789'))

  return Object.fromEntries(Object.entries(outcomes).map(([name, evidence]) => [name, evidenceProjection(evidence)]))
}
