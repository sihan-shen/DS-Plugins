import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createBudgetControllerRegistry } from '../../packages/dsh-orchestrator/src/budgets.ts'
import { appendBudgetRejected } from '../../packages/dsh-orchestrator/src/events.ts'
import { fixedProfileSchedule } from '../../packages/dsh-orchestrator/src/scheduling.ts'
import { createDelegateWorkerTool, runWorker } from '../../packages/dsh-orchestrator/src/worker.ts'
import type { HandoffV1, OrchestratorConfig } from '../../packages/dsh-orchestrator/src/types.ts'
import type { ResolvedScheduleV1 } from '../../packages/dsh-orchestrator/src/scheduling.ts'

const config: OrchestratorConfig = {
  workspaceRoot: '/workspace/dsh',
  mode: 'single-worker',
  worker: { provider: 'replay', model: 'replay', maxTokens: 32_000 },
  budgets: { maxWorkers: 1, maxPluginToolActions: 2, toolTimeoutMs: 60_000 },
  verification: {
    commands: [{ name: 'typecheck', executable: 'pnpm', fixedArgs: ['typecheck'], allowedArgs: 'none' }],
    timeoutMs: 60_000,
    maxOutputBytes: 4_096,
  },
}

const validHandoff: HandoffV1 = {
  schemaVersion: 1,
  status: 'completed',
  summary: 'Applied the focused change.',
  changedFiles: ['packages/dsh-orchestrator/src/worker.ts'],
  decisions: ['Returned only HandoffV1.'],
  verification: [],
  blockers: [],
}

const resolvedSchedule = {
  request: {} as never,
  decision: fixedProfileSchedule(config.worker, config.mode, 'worker'),
} as ResolvedScheduleV1

class ReplaySubagents {
  starts = 0

  constructor(private readonly structured: unknown) {}

  async start() {
    this.starts += 1
    return {
      id: SessionId(`replay-child-${this.starts}`),
      result: Promise.resolve({ stopReason: 'completed' as const, structured: this.structured, output: [] }),
      dispose: async () => undefined,
    }
  }
}

function session(id: string) {
  return Session.create(SessionId(id), undefined, {
    version: 0,
    id: SessionId(id),
    createdAt: 0,
    cwd: config.workspaceRoot,
  })
}

/** Execute one success, one worker-budget rejection, and one scrubbed invalid result. */
export async function replaySingleWorkerFixture() {
  const parent = { session: session('replay-single-worker') }
  const registry = createBudgetControllerRegistry(config.budgets, () => rejection => {
    appendBudgetRejected(parent.session, {
      reason: rejection.code,
      limit: rejection.limit,
      observed: rejection.observed,
    })
  })
  const subagents = new ReplaySubagents(validHandoff)
  const deferred: unknown[] = []
  const tool = createDelegateWorkerTool({
    config,
    subagents: subagents as never,
    budgetRegistry: registry,
    schedulerResolver: { current: () => undefined },
  })
  const first = await tool.execute(
    { task: 'Apply the focused change.', allowedTools: ['read_file'] },
    { signal: new AbortController().signal, agent: parent, deferContext: (message: unknown) => { deferred.push(message) } } as never,
  ) as HandoffV1
  let secondError = ''
  try {
    await tool.execute(
      { task: 'Start a second worker.', allowedTools: ['read_file'] },
      { signal: new AbortController().signal, agent: parent } as never,
    )
  } catch (error) {
    secondError = error instanceof Error ? error.message : String(error)
  }
  const startsBeforeInvalidOutput = subagents.starts

  const invalidParent = { session: session('replay-invalid-worker') }
  const invalid = await runWorker({
    config,
    resolvedSchedule,
    parent: invalidParent as never,
    task: 'Return malformed structured output.',
    allowedTools: ['read_file'],
    signal: new AbortController().signal,
    subagents: new ReplaySubagents({ schemaVersion: 2, transcript: 'SECRET_CHILD_OUTPUT' }) as never,
  })

  return {
    first,
    deferred: deferred.map(message => JSON.parse((message as { content: [{ text: string }] }).content[0].text)),
    startsBeforeInvalidOutput,
    secondError,
    events: parent.session.events.map(event => ({ type: event.type, data: event.data })),
    invalid,
    invalidEvents: invalidParent.session.events.map(event => ({ type: event.type, data: event.data })),
  }
}
