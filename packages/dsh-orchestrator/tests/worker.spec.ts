import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createDelegateWorkerTool, HANDOFF_V1_JSON_SCHEMA, mountSingleWorkerMode, runWorker, SINGLE_WORKER_STARTUP_TIMEOUT_MS } from '../src/worker.ts'
import type { HandoffV1, OrchestratorConfig } from '../src/types.ts'

const workspaceRoot = '/workspace/ds-plugins'

const config: OrchestratorConfig = {
  workspaceRoot,
  mode: 'single-worker',
  worker: {
    provider: 'openai-codex',
    model: 'gpt-5.6-codex',
    reasoningEffort: 'high',
    maxTokens: 32_000,
  },
  budgets: {
    maxWorkers: 1,
    maxPluginToolActions: 2,
    toolTimeoutMs: 60_000,
  },
  verification: {
    commands: [{
      name: 'typecheck',
      executable: 'pnpm',
      fixedArgs: ['typecheck'],
      allowedArgs: 'none',
    }],
    timeoutMs: 60_000,
    maxOutputBytes: 4_096,
  },
}

const validHandoff: HandoffV1 = {
  schemaVersion: 1,
  status: 'completed',
  summary: 'Updated the focused worker file.',
  changedFiles: ['packages/dsh-orchestrator/src/worker.ts'],
  decisions: ['Kept the delegation foreground-only.'],
  verification: [],
  blockers: [],
}

interface FakeRequest {
  readonly prompt: readonly { readonly type: string; readonly text?: string }[]
  readonly parent: unknown
  readonly signal: AbortSignal
  readonly agentOptions?: {
    readonly provider?: string
    readonly model?: string
    readonly reasoningEffort?: string
    readonly maxTokens?: number
  }
  readonly outputSchema?: unknown
  readonly maxDepth?: number
  readonly toolFilter?: unknown
}

interface FakeResult {
  readonly stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
  readonly structured?: unknown
  readonly output: readonly unknown[]
  readonly diagnostic?: string
}

interface FakeRun {
  readonly id: ReturnType<typeof SessionId>
  readonly result: Promise<FakeResult>
  dispose(): Promise<void>
}

type Start = (request: FakeRequest) => Promise<FakeRun>

class FakeSubagents {
  readonly requests: FakeRequest[] = []
  readonly providers: string[] = []

  constructor(private readonly startRun: Start) {}

  start(provider: string, request: FakeRequest): Promise<FakeRun> {
    this.providers.push(provider)
    this.requests.push(request)
    return this.startRun(request)
  }
}

function publishedRun(
  result: Promise<FakeResult>,
  id = 'child-worker-session',
  disposeRun: () => Promise<void> = async () => undefined,
): { readonly run: FakeRun; readonly dispose: ReturnType<typeof vi.fn> } {
  const dispose = vi.fn(disposeRun)
  return { run: { id: SessionId(id), result, dispose }, dispose }
}

function rootSession(id = 'worker-root-session') {
  return Session.create(SessionId(id), undefined, {
    version: 0,
    id: SessionId(id),
    createdAt: 0,
    cwd: workspaceRoot,
  })
}

function parentFor(session = rootSession()) {
  const injected: unknown[] = []
  return {
    parent: {
      session,
      inject(message: unknown) { injected.push(message) },
    },
    injected,
  }
}

function workerOptions(overrides: Partial<Parameters<typeof runWorker>[0]> = {}) {
  const { parent, injected } = parentFor()
  const run = publishedRun(Promise.resolve({
    stopReason: 'completed',
    structured: validHandoff,
    output: [{ type: 'text', text: 'SECRET_TRANSCRIPT_MARKER' }],
  }))
  const subagents = new FakeSubagents(async () => run.run)
  return {
    options: {
      config,
      parent,
      task: 'Update the focused worker file.',
      allowedTools: ['read_file', 'write_file'],
      signal: new AbortController().signal,
      subagents,
      ...overrides,
    },
    injected,
    run,
    subagents,
  }
}

function injectedText(message: unknown): string {
  const candidate = message as { readonly content?: readonly { readonly type?: string; readonly text?: string }[] }
  const first = candidate.content?.[0]
  if (first?.type !== 'text' || typeof first.text !== 'string') throw new Error('expected one injected text message')
  return first.text
}

function toolRegistry() {
  const tools = new Map<string, { readonly name: string }>()
  return {
    register(tool: { readonly name: string }) {
      if (tools.has(tool.name)) throw new Error(`duplicate tool: ${tool.name}`)
      tools.set(tool.name, tool)
      return () => { tools.delete(tool.name) }
    },
    get(name: string) {
      return tools.get(name)
    },
  }
}

async function mountedSingleWorkerMode() {
  const ctx = new Context()
  const sessionStore = await ctx.plugin(SessionStore)
  const tools = toolRegistry()
  ctx.provide('tools', tools as never)
  ctx.provide('subagents', new FakeSubagents(async () => {
    throw new Error('worker should not start while testing root route evidence')
  }) as never)
  const budgetRegistry = {
    forRootSession: () => ({
      admitPluginTool: () => ({ allowed: true as const }),
      admitWorker: () => ({ allowed: true as const }),
    }),
  }
  const fiber = await ctx.plugin(child => {
    mountSingleWorkerMode(child, config, budgetRegistry)
  })
  return { ctx, sessionStore, fiber }
}

describe('one-shot worker runtime', () => {
  it('starts one bounded foreground child, awaits its result, disposes it, and records only the validated handoff', async () => {
    let settle = (_result: FakeResult) => undefined
    const result = new Promise<FakeResult>(resolve => { settle = resolve })
    const run = publishedRun(result)
    const { parent, injected } = parentFor()
    const subagents = new FakeSubagents(async () => run.run)

    const running = runWorker({
      config,
      parent,
      task: 'Update the focused worker file.',
      allowedTools: ['read_file', 'write_file'],
      signal: new AbortController().signal,
      subagents,
    })

    await Promise.resolve()
    expect(subagents.providers).toEqual(['spawn'])
    expect(subagents.requests).toHaveLength(1)
    const [request] = subagents.requests
    expect(request?.maxDepth).toBe(1)
    expect(request?.agentOptions).toMatchObject({
      provider: config.worker.provider,
      model: config.worker.model,
      maxTokens: config.worker.maxTokens,
    })
    expect(request?.outputSchema).toEqual(HANDOFF_V1_JSON_SCHEMA)
    expect(request?.toolFilter).toEqual({ allow: ['read_file', 'write_file'] })
    const prompt = request?.prompt.map(block => block.text ?? '').join('\n') ?? ''
    expect(prompt).toContain('Update the focused worker file.')
    expect(prompt).toContain('HandoffV1')
    expect(prompt).not.toContain('SECRET_TRANSCRIPT_MARKER')
    expect(run.dispose).not.toHaveBeenCalled()

    settle({
      stopReason: 'completed',
      structured: validHandoff,
      output: [{ type: 'text', text: 'SECRET_TRANSCRIPT_MARKER' }],
    })

    await expect(running).resolves.toEqual(validHandoff)
    expect(run.dispose).toHaveBeenCalledTimes(1)
    expect(parent.session.events.map(event => event.type)).toEqual([
      'dsh-plugin/worker-requested',
      'dsh-plugin/worker-finished',
    ])
    expect(parent.session.events[1]).toMatchObject({
      data: { childSessionId: SessionId('child-worker-session'), handoff: validHandoff },
    })
    expect(injected).toEqual([])
  })

  it.each([
    ['aborted', 'blocked'],
    ['error', 'failed'],
    ['max-tokens', 'blocked'],
    ['refusal', 'blocked'],
  ] as const)('normalizes a %s child result without copying transcript or diagnostic data', async (stopReason, status) => {
    const run = publishedRun(Promise.resolve({
      stopReason,
      output: [{ type: 'text', text: 'SECRET_TRANSCRIPT_MARKER' }],
      diagnostic: 'SECRET_TRANSCRIPT_MARKER',
    }))
    const { parent, injected } = parentFor()
    const handoff = await runWorker({
      config,
      parent,
      task: 'Bounded task.',
      allowedTools: ['read_file'],
      signal: new AbortController().signal,
      subagents: new FakeSubagents(async () => run.run),
    })

    expect(handoff.status).toBe(status)
    expect(JSON.stringify(handoff)).not.toContain('SECRET_TRANSCRIPT_MARKER')
    expect(parent.session.events.filter(event => event.type === 'dsh-plugin/worker-finished')).toHaveLength(1)
    expect(JSON.stringify(parent.session.events)).not.toContain('SECRET_TRANSCRIPT_MARKER')
    expect(injected).toEqual([])
    expect(run.dispose).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['invalid structured output', { schemaVersion: 2 }, [{ type: 'text', text: 'SECRET_TRANSCRIPT_MARKER' }]],
    ['raw-only output', undefined, [{ type: 'text', text: 'SECRET_TRANSCRIPT_MARKER' }]],
  ] as const)('returns a scrubbed failed handoff for %s', async (_label, structured, output) => {
    const run = publishedRun(Promise.resolve({ stopReason: 'completed', structured, output }))
    const { options, injected } = workerOptions({ subagents: new FakeSubagents(async () => run.run) })

    const handoff = await runWorker(options)

    expect(handoff).toMatchObject({ status: 'failed', changedFiles: [], verification: [] })
    expect(JSON.stringify(handoff)).not.toContain('SECRET_TRANSCRIPT_MARKER')
    expect(injected).toEqual([])
    expect(run.dispose).toHaveBeenCalledTimes(1)
  })

  it('normalizes a disposal rejection into a scrubbed failed handoff and appends completion evidence', async () => {
    const run = publishedRun(
      Promise.resolve({ stopReason: 'completed', structured: validHandoff, output: [] }),
      'child-worker-dispose-rejection',
      async () => { throw new Error('SECRET_TRANSCRIPT_MARKER') },
    )
    const { parent, injected } = parentFor()

    const handoff = await runWorker({
      config,
      parent,
      task: 'Bounded task.',
      allowedTools: ['read_file'],
      signal: new AbortController().signal,
      subagents: new FakeSubagents(async () => run.run),
    })

    expect(handoff).toMatchObject({ status: 'failed', changedFiles: [], verification: [] })
    expect(JSON.stringify(handoff)).not.toContain('SECRET_TRANSCRIPT_MARKER')
    expect(parent.session.events.map(event => event.type)).toEqual([
      'dsh-plugin/worker-requested',
      'dsh-plugin/worker-finished',
    ])
    expect(JSON.stringify(parent.session.events)).not.toContain('SECRET_TRANSCRIPT_MARKER')
    expect(injected).toEqual([])
    expect(run.dispose).toHaveBeenCalledTimes(1)
  })

  it('normalizes start infrastructure rejection without publishing a child event or injection', async () => {
    const { parent, injected } = parentFor()
    const subagents = new FakeSubagents(async () => { throw new Error('SECRET_TRANSCRIPT_MARKER') })

    const handoff = await runWorker({
      config,
      parent,
      task: 'Bounded task.',
      allowedTools: ['read_file'],
      signal: new AbortController().signal,
      subagents,
    })

    expect(handoff).toMatchObject({ status: 'failed', changedFiles: [], verification: [] })
    expect(JSON.stringify(handoff)).not.toContain('SECRET_TRANSCRIPT_MARKER')
    expect(parent.session.events.map(event => event.type)).toEqual(['dsh-plugin/worker-requested'])
    expect(injected).toEqual([])
  })

  it('returns a blocked handoff before publication when the caller is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort(new Error('SECRET_TRANSCRIPT_MARKER'))
    const { parent, injected } = parentFor()
    const subagents = new FakeSubagents(async () => { throw new Error('must not start') })

    const handoff = await runWorker({
      config,
      parent,
      task: 'Bounded task.',
      allowedTools: ['read_file'],
      signal: controller.signal,
      subagents,
    })

    expect(handoff).toMatchObject({ status: 'blocked', changedFiles: [], verification: [] })
    expect(JSON.stringify(handoff)).not.toContain('SECRET_TRANSCRIPT_MARKER')
    expect(subagents.requests).toEqual([])
    expect(parent.session.events).toEqual([])
    expect(injected).toEqual([])
  })

  it('records the published child handoff but does not inject after caller cancellation', async () => {
    const controller = new AbortController()
    let settle = (_result: FakeResult) => undefined
    const result = new Promise<FakeResult>(resolve => { settle = resolve })
    const run = publishedRun(result)
    const { parent, injected } = parentFor()
    const subagents = new FakeSubagents(async () => run.run)
    const running = runWorker({
      config,
      parent,
      task: 'Bounded task.',
      allowedTools: ['read_file'],
      signal: controller.signal,
      subagents,
    })

    await Promise.resolve()
    controller.abort(new Error('SECRET_TRANSCRIPT_MARKER'))
    settle({
      stopReason: 'aborted',
      output: [{ type: 'text', text: 'SECRET_TRANSCRIPT_MARKER' }],
      diagnostic: 'SECRET_TRANSCRIPT_MARKER',
    })

    await expect(running).resolves.toMatchObject({ status: 'blocked' })
    expect(parent.session.events.map(event => event.type)).toEqual([
      'dsh-plugin/worker-requested',
      'dsh-plugin/worker-finished',
    ])
    expect(JSON.stringify(parent.session.events)).not.toContain('SECRET_TRANSCRIPT_MARKER')
    expect(injected).toEqual([])
    expect(run.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('delegate_worker tool', () => {
  it('admits one delegation before starting, binds a scrubbed handoff to its tool result, and rejects the second without invoking the provider', async () => {
    const { parent, injected } = parentFor()
    const first = publishedRun(Promise.resolve({ stopReason: 'completed', structured: validHandoff, output: [] }))
    const subagents = new FakeSubagents(async () => first.run)
    const admitPluginTool = vi.fn(() => ({ allowed: true as const }))
    const admitWorker = vi.fn()
      .mockReturnValueOnce({ allowed: true as const })
      .mockReturnValueOnce({ allowed: false as const, code: 'WORKER_LIMIT', limit: 1, observed: 2 })
    const tool = createDelegateWorkerTool({
      config,
      subagents,
      budgetRegistry: { forRootSession: () => ({ admitPluginTool, admitWorker }) },
    })
    const deferContext = vi.fn()

    await expect(tool.execute(
      { task: 'Bounded task.', allowedTools: ['read_file'] },
      { signal: new AbortController().signal, agent: parent, deferContext } as never,
    )).resolves.toEqual(validHandoff)
    await expect(tool.execute(
      { task: 'Different bounded task.', allowedTools: ['read_file'] },
      { signal: new AbortController().signal, agent: parent } as never,
    )).rejects.toThrow(/WORKER_LIMIT/)

    expect(admitPluginTool).toHaveBeenCalledTimes(2)
    expect(admitWorker).toHaveBeenCalledTimes(2)
    expect(subagents.requests).toHaveLength(1)
    expect(first.dispose).toHaveBeenCalledTimes(1)
    expect(injected).toEqual([])
    expect(deferContext).toHaveBeenCalledTimes(1)
    const [context] = deferContext.mock.calls[0] ?? []
    expect(context).toMatchObject({
      source: {
        kind: 'plugin',
        plugin: 'ds-orchestrator',
        form: 'notice',
        summary: validHandoff.summary,
      },
    })
    const projection = JSON.parse(injectedText(context))
    expect(projection).toEqual({
      status: validHandoff.status,
      summary: validHandoff.summary,
      changedFiles: validHandoff.changedFiles,
      decisions: validHandoff.decisions,
      verification: validHandoff.verification,
      blockers: validHandoff.blockers,
    })
    expect(injectedText(context)).not.toContain('SECRET_TRANSCRIPT_MARKER')
  })

  it('validates tool input and pre-aborted cancellation before charging either budget', async () => {
    const { parent } = parentFor()
    const subagents = new FakeSubagents(async () => { throw new Error('must not start') })
    const admitPluginTool = vi.fn(() => ({ allowed: true as const }))
    const admitWorker = vi.fn(() => ({ allowed: true as const }))
    const tool = createDelegateWorkerTool({
      config,
      subagents,
      budgetRegistry: { forRootSession: () => ({ admitPluginTool, admitWorker }) },
    })
    const aborted = new AbortController()
    const cancellation = new Error('already cancelled')
    aborted.abort(cancellation)

    await expect(tool.execute(
      { task: '', allowedTools: ['read_file'] },
      { signal: new AbortController().signal, agent: parent } as never,
    )).rejects.toThrow(/task/i)
    await expect(tool.execute(
      { task: 'Bounded task.', allowedTools: ['read_file', 'read_file'] },
      { signal: new AbortController().signal, agent: parent } as never,
    )).rejects.toThrow(/allowedTools/i)
    await expect(tool.execute(
      { task: 'Bounded task.', allowedTools: ['read_file'], unexpected: true },
      { signal: new AbortController().signal, agent: parent } as never,
    )).rejects.toThrow(/unknown|unsupported/i)
    await expect(tool.execute(
      { task: 'Bounded task.', allowedTools: ['read_file'] },
      { signal: aborted.signal, agent: parent } as never,
    )).rejects.toBe(cancellation)

    expect(admitPluginTool).not.toHaveBeenCalled()
    expect(admitWorker).not.toHaveBeenCalled()
    expect(subagents.requests).toEqual([])
  })
})

describe('single-worker service lifecycle', () => {
  it('waits for a late subagents service before the fixed startup deadline', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const tools = toolRegistry()
    ctx.provide('tools', tools as never)
    const budgetRegistry = {
      forRootSession: () => ({
        admitPluginTool: () => ({ allowed: true as const }),
        admitWorker: () => ({ allowed: true as const }),
      }),
    }
    const fiber = ctx.plugin(child => mountSingleWorkerMode(child, config, budgetRegistry))

    expect(tools.get('delegate_worker')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(SINGLE_WORKER_STARTUP_TIMEOUT_MS - 1)
    ctx.provide('subagents', new FakeSubagents(async () => {
      throw new Error('worker should not start in this lifecycle test')
    }) as never)
    await fiber
    expect(tools.get('delegate_worker')).toBeDefined()

    await fiber.dispose()
    expect(tools.get('delegate_worker')).toBeUndefined()
    vi.useRealTimers()
  })

  it('rejects Single Worker startup after the fixed missing-subagents deadline', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    ctx.provide('tools', toolRegistry() as never)
    const fiber = ctx.plugin(child => mountSingleWorkerMode(child, config, {
      forRootSession: () => ({ admitPluginTool: () => ({ allowed: true as const }), admitWorker: () => ({ allowed: true as const }) }),
    }))
    await vi.advanceTimersByTimeAsync(SINGLE_WORKER_STARTUP_TIMEOUT_MS)
    await expect(fiber).rejects.toThrow(/single-worker.*subagents.*timeout/i)
    vi.useRealTimers()
  })

  it('cancels a pending Single Worker startup on disposal without mounting late', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    const tools = toolRegistry()
    ctx.provide('tools', tools as never)
    const fiber = ctx.plugin(child => mountSingleWorkerMode(child, config, {
      forRootSession: () => ({ admitPluginTool: () => ({ allowed: true as const }), admitWorker: () => ({ allowed: true as const }) }),
    }))
    await fiber.dispose()
    await vi.advanceTimersByTimeAsync(SINGLE_WORKER_STARTUP_TIMEOUT_MS)
    ctx.provide('subagents', new FakeSubagents(async () => { throw new Error('must not mount') }) as never)
    expect(tools.get('delegate_worker')).toBeUndefined()
    vi.useRealTimers()
  })

  it('records the actual root request route and ignores malformed route snapshots', async () => {
    const mounted = await mountedSingleWorkerMode()
    const routed = mounted.ctx.sessions.create(SessionId('worker-resolved-route'), {
      meta: { cwd: workspaceRoot },
    })
    routed.append('request/header', {
      header: { config: { provider: 'deepseek', model: 'deepseek-reasoner' } },
      reason: 'initial',
    })
    const missingModel = mounted.ctx.sessions.create(SessionId('worker-missing-route-field'), {
      meta: { cwd: workspaceRoot },
    })
    missingModel.append('request/header', {
      header: { config: { provider: 'deepseek' } },
      reason: 'initial',
    } as never)
    const malformedConfig = mounted.ctx.sessions.create(SessionId('worker-malformed-route-shape'), {
      meta: { cwd: workspaceRoot },
    })
    malformedConfig.append('request/header', {
      header: { config: 'not-a-route' },
      reason: 'initial',
    } as never)
    await Promise.resolve()

    expect(routed.events.filter(event => event.type === 'dsh-plugin/run-started')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ mode: 'single-worker', provider: 'deepseek', model: 'deepseek-reasoner' }),
      }),
    ])
    expect(missingModel.events.filter(event => event.type === 'dsh-plugin/run-started')).toEqual([])
    expect(malformedConfig.events.filter(event => event.type === 'dsh-plugin/run-started')).toEqual([])

    await mounted.fiber.dispose()
    await mounted.sessionStore.dispose()
  })
})
