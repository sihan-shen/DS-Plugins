import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  createTargetedVerificationTool,
  VERIFICATION_CLEANUP_ALLOWANCE_MS,
  VerificationService,
} from '../src/verification.ts'

interface FakeOutcome {
  readonly exitCode: number | null
  readonly signal: string | null
}

interface FakeSpawnSpec {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stdio: {
    readonly stdin: 'ignore'
    readonly stdout: { readonly maxBytes: number }
    readonly stderr: { readonly maxBytes: number }
  }
  readonly graceMs: number
  readonly signal?: AbortSignal
}

interface FakeHandle {
  readonly done: Promise<FakeOutcome>
  readonly collected: {
    readonly stdout?: { readFrom(offset: number): { text: string; lossy: boolean } }
    readonly stderr?: { readFrom(offset: number): { text: string; lossy: boolean } }
  }
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

type HandleFactory = (spec: FakeSpawnSpec) => FakeHandle

class FakeSubprocess {
  readonly spawns: FakeSpawnSpec[] = []

  constructor(private readonly next: HandleFactory) {}

  spawn(spec: FakeSpawnSpec): FakeHandle {
    this.spawns.push(spec)
    return this.next(spec)
  }
}

function handle(
  outcome: Promise<FakeOutcome>,
  options: { readonly stdout?: string; readonly stderr?: string; readonly stdoutLossy?: boolean; readonly stderrLossy?: boolean } = {},
): FakeHandle {
  return {
    done: outcome,
    collected: {
      stdout: {
        readFrom: () => ({ text: options.stdout ?? '', lossy: options.stdoutLossy ?? false }),
      },
      stderr: {
        readFrom: () => ({ text: options.stderr ?? '', lossy: options.stderrLossy ?? false }),
      },
    },
    terminate: () => undefined,
    waitForExit: async () => true,
  }
}

const workspaceRoot = '/workspace/ds-plugins'
const verification = {
  commands: [
    { name: 'typecheck', executable: 'pnpm', fixedArgs: ['typecheck'], allowedArgs: 'none' },
    { name: 'test:orchestrator', executable: 'pnpm', fixedArgs: ['exec', 'vitest', 'run'], allowedArgs: 'orchestrator-test-paths' },
  ],
  timeoutMs: 20,
  maxOutputBytes: 8,
} as const

function service(subprocess: FakeSubprocess, finished: unknown[] = []) {
  return new VerificationService({
    workspaceRoot,
    verification,
    subprocess,
    appendEvidence(evidence) {
      finished.push(evidence)
    },
  })
}

describe('targeted verification service', () => {
  it('runs a configured command directly and records a passed evidence event', async () => {
    const subprocess = new FakeSubprocess(() => handle(Promise.resolve({ exitCode: 0, signal: null }), {
      stdout: 'all checks passed\n',
    }))
    const finished: unknown[] = []

    const evidence = await service(subprocess, finished).run('typecheck', [], new AbortController().signal)

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      commandName: 'typecheck',
      args: [],
      exitCode: 0,
      status: 'passed',
      stderr: '',
      truncated: true,
    })
    expect(Buffer.byteLength(evidence.stdout)).toBeLessThanOrEqual(verification.maxOutputBytes)
    expect(finished).toEqual([evidence])
    expect(subprocess.spawns).toHaveLength(1)
    const [spawnSpec] = subprocess.spawns
    expect(spawnSpec?.argv).toEqual(['pnpm', 'typecheck'])
    expect(spawnSpec?.cwd).toBe(workspaceRoot)
    expect(spawnSpec).not.toHaveProperty('shell')
    expect(spawnSpec).not.toHaveProperty('env')
  })

  it('records a non-zero process outcome as failed', async () => {
    const finished: unknown[] = []
    const evidence = await service(new FakeSubprocess(() => handle(Promise.resolve({ exitCode: 1, signal: null }), {
      stderr: 'typecheck failed',
    })), finished).run('typecheck', [], new AbortController().signal)

    expect(evidence).toMatchObject({ status: 'failed', exitCode: 1 })
    expect(finished).toEqual([evidence])
  })

  it('owns a timeout, terminates through the subprocess signal, and records timed-out evidence', async () => {
    let received: FakeSpawnSpec | undefined
    const finished: unknown[] = []
    const subprocess = new FakeSubprocess(spec => {
      received = spec
      return handle(new Promise(resolve => {
        spec.signal?.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })
      }))
    })

    const evidence = await service(subprocess, finished).run('typecheck', [], new AbortController().signal)

    expect(received?.signal?.aborted).toBe(true)
    expect(evidence).toMatchObject({ status: 'timed-out', exitCode: null })
    expect(finished).toEqual([evidence])
  })

  it('maps a spawn-level failure to spawn-error and records it', async () => {
    const finished: unknown[] = []
    const evidence = await service(new FakeSubprocess(() => handle(Promise.reject(new Error('spawn failed')))), finished)
      .run('typecheck', [], new AbortController().signal)

    expect(evidence).toMatchObject({ status: 'spawn-error', exitCode: null })
    expect(finished).toEqual([evidence])
  })

  it('propagates caller cancellation after recording the actual terminated process outcome', async () => {
    const controller = new AbortController()
    const reason = new Error('caller cancelled verification')
    const finished: unknown[] = []
    const subprocess = new FakeSubprocess(spec => handle(new Promise(resolve => {
      spec.signal?.addEventListener('abort', () => resolve({ exitCode: null, signal: 'SIGTERM' }), { once: true })
    })))
    const running = service(subprocess, finished).run('typecheck', [], controller.signal)

    controller.abort(reason)

    await expect(running).rejects.toBe(reason)
    expect(finished).toMatchObject([{ status: 'failed', exitCode: null }])
  })

  it('bounds UTF-8 stdout and stderr together without leaving an invalid code point', async () => {
    const evidence = await service(new FakeSubprocess(() => handle(Promise.resolve({ exitCode: 0, signal: null }), {
      stdout: '€abc',
      stderr: 'éxyz',
    })), []).run('typecheck', [], new AbortController().signal)

    expect(Buffer.byteLength(evidence.stdout) + Buffer.byteLength(evidence.stderr)).toBeLessThanOrEqual(verification.maxOutputBytes)
    expect(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(evidence.stdout))).toBe(evidence.stdout)
    expect(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(evidence.stderr))).toBe(evidence.stderr)
    expect(evidence.truncated).toBe(true)
  })

  it.each([
    ['typecheck caller arguments', 'typecheck', ['--all']],
    ['NUL argument', 'test:orchestrator', ['packages/dsh-orchestrator/tests/ok.spec.ts\0--runInBand']],
    ['POSIX traversal', 'test:orchestrator', ['packages/dsh-orchestrator/tests/../outside.spec.ts']],
    ['Windows traversal', 'test:orchestrator', ['packages\\dsh-orchestrator\\tests\\..\\outside.spec.ts']],
    ['absolute POSIX path', 'test:orchestrator', ['/tmp/ok.spec.ts']],
    ['absolute Windows path', 'test:orchestrator', ['C:\\temp\\ok.spec.ts']],
    ['non-test path', 'test:orchestrator', ['packages/dsh-orchestrator/src/index.ts']],
  ])('rejects %s before a process is admitted or a verification event exists', async (_label, command, args) => {
    const subprocess = new FakeSubprocess(() => handle(Promise.resolve({ exitCode: 0, signal: null })))
    const finished: unknown[] = []

    await expect(service(subprocess, finished).run(command, args, new AbortController().signal)).rejects.toThrow(/verification/i)
    expect(subprocess.spawns).toEqual([])
    expect(finished).toEqual([])
  })

  it('rejects an unknown command before a process is admitted or a verification event exists', async () => {
    const subprocess = new FakeSubprocess(() => handle(Promise.resolve({ exitCode: 0, signal: null })))
    const finished: unknown[] = []

    await expect(service(subprocess, finished).run('shell', [], new AbortController().signal)).rejects.toThrow(/unknown verification command/i)
    expect(subprocess.spawns).toEqual([])
    expect(finished).toEqual([])
  })
})

describe('targeted_verify tool definition', () => {
  it('uses a generic tool card, admits the budget before spawning, and does not record verification after budget rejection', async () => {
    const session = Session.create(SessionId('verification-tool-session'), undefined, {
      version: 0,
      id: SessionId('verification-tool-session'),
      createdAt: 0,
      cwd: workspaceRoot,
    })
    const subprocess = new FakeSubprocess(() => handle(Promise.resolve({ exitCode: 0, signal: null })))
    const admitPluginTool = vi.fn(() => ({ allowed: false as const, code: 'PLUGIN_TOOL_LIMIT', limit: 0, observed: 1 }))
    const tool = createTargetedVerificationTool({
      verification,
      subprocess,
      budgetRegistry: { forRootSession: () => ({ admitPluginTool }) },
    })

    expect(tool.name).toBe('targeted_verify')
    expect(tool.timeoutMs).toBeGreaterThanOrEqual(verification.timeoutMs + VERIFICATION_CLEANUP_ALLOWANCE_MS)
    expect(tool.presentCall?.({ command: 'typecheck', args: [] })).toMatchObject({
      card: 'generic',
      title: 'Run targeted verification',
      kind: 'execute',
    })

    await expect(tool.execute(
      { command: 'typecheck', args: [] },
      { signal: new AbortController().signal, agent: { session } } as never,
    )).rejects.toThrow(/PLUGIN_TOOL_LIMIT/)
    expect(admitPluginTool).toHaveBeenCalledWith('targeted_verify')
    expect(subprocess.spawns).toEqual([])
    expect(session.events.filter(event => event.type === 'dsh-plugin/verification-finished')).toEqual([])
  })
})
