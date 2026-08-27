import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { BudgetControllerRegistry } from './budgets.js'
import { appendVerificationFinished } from './events.js'
import type { OrchestratorConfig, VerificationCommand, VerificationEvidenceV1 } from './types.js'

/** Extra time reserved for tree quiescence after the verification deadline fires. */
export const VERIFICATION_CLEANUP_ALLOWANCE_MS = 5_000

/** Maximum TERM-to-KILL grace given to one verification process tree. */
export const VERIFICATION_TERMINATION_GRACE_MS = 5_000

/** Receives each evidence record once its admitted verification process settles. */
export type VerificationEvidenceAppender = (evidence: VerificationEvidenceV1) => void

/** Dependencies and deployment policy for one verification service. */
export interface VerificationServiceOptions {
  readonly workspaceRoot: string
  readonly verification: OrchestratorConfig['verification']
  readonly subprocess: Pick<SubprocessRuntime, 'spawn'>
  readonly appendEvidence: VerificationEvidenceAppender
}

/** Dependencies for the model-facing targeted verification definition. */
export interface TargetedVerificationToolOptions {
  /** Deployment-supplied, trusted repository root; never derived from an agent session. */
  readonly workspaceRoot: string
  readonly verification: OrchestratorConfig['verification']
  readonly subprocess: Pick<SubprocessRuntime, 'spawn'>
  readonly budgetRegistry: Pick<BudgetControllerRegistry, 'forRootSession'>
}

interface CapturedOutput {
  readonly text: string
  readonly truncated: boolean
}

interface EvidenceOutput {
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
}

interface TargetedVerifyInput {
  readonly command: string
  readonly args: readonly string[]
}

interface ValidatedVerificationRequest {
  readonly command: VerificationCommand
  readonly args: readonly string[]
}

const utf8Encoder = new TextEncoder()

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength
}

function unknownCommand(commandName: string): never {
  throw new TypeError(`unknown verification command: ${JSON.stringify(commandName)}`)
}

function commandFor(commands: readonly VerificationCommand[], commandName: string): VerificationCommand {
  return commands.find(command => command.name === commandName) ?? unknownCommand(commandName)
}

function testPath(argument: string): void {
  if (argument.includes('\0')) throw new TypeError('verification argument must not contain NUL')
  if (argument.includes('\\') || /^[A-Za-z]:/u.test(argument) || argument.startsWith('/')) {
    throw new TypeError('verification test path must be a POSIX repository-relative path')
  }
  if (!argument.startsWith('packages/dsh-orchestrator/tests/')) {
    throw new TypeError('verification test path must stay under packages/dsh-orchestrator/tests/')
  }
  const segments = argument.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new TypeError('verification test path must not contain traversal segments')
  }
  if (!/\.(?:spec|test)\.[cm]?[jt]sx?$/u.test(argument)) {
    throw new TypeError('verification test path must name a test file')
  }
}

function validatedArgs(command: VerificationCommand, args: readonly string[]): readonly string[] {
  if (!Array.isArray(args)) throw new TypeError('verification arguments must be an array')
  for (const argument of args) {
    if (typeof argument !== 'string') throw new TypeError('verification arguments must be strings')
    if (argument.includes('\0')) throw new TypeError('verification argument must not contain NUL')
  }
  if (command.allowedArgs === 'none') {
    if (args.length > 0) throw new TypeError(`verification command ${JSON.stringify(command.name)} accepts no caller arguments`)
    return []
  }
  for (const argument of args) testPath(argument)
  return [...args]
}

function validatedRequest(
  commands: readonly VerificationCommand[],
  commandName: string,
  args: readonly string[],
): ValidatedVerificationRequest {
  const command = commandFor(commands, commandName)
  return { command, args: validatedArgs(command, args) }
}

function trustedWorkspaceRoot(value: string): string {
  if (value.length === 0 || value.includes('\0')) {
    throw new TypeError('workspaceRoot must be a non-empty path without NUL bytes')
  }
  return value
}

function outputReader(reader: { readFrom(offset: number): { text: string; lossy: boolean } } | undefined): CapturedOutput {
  if (reader === undefined) return { text: '', truncated: false }
  const result = reader.readFrom(0)
  return { text: result.text, truncated: result.lossy }
}

function utf8Tail(value: string, maxBytes: number): CapturedOutput {
  const bytes = utf8Encoder.encode(value)
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const first = Math.max(0, bytes.byteLength - maxBytes)
  for (let offset = first; offset < bytes.byteLength; offset += 1) {
    try {
      return { text: decoder.decode(bytes.subarray(offset)), truncated: true }
    } catch {
      // A bounded tail may start inside one UTF-8 code point; advance to its next boundary.
    }
  }
  return { text: '', truncated: true }
}

/**
 * Keep evidence within one combined byte cap. Each subprocess collector has the same
 * per-stream cap so it can truthfully report overflow; the returned stdout and stderr
 * receive proportional UTF-8-safe tail quotas whose sum never exceeds that combined cap.
 */
function boundEvidenceOutput(stdout: CapturedOutput, stderr: CapturedOutput, maxOutputBytes: number): EvidenceOutput {
  const stdoutBytes = utf8ByteLength(stdout.text)
  const stderrBytes = utf8ByteLength(stderr.text)
  const totalBytes = stdoutBytes + stderrBytes
  if (totalBytes <= maxOutputBytes) {
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
    }
  }
  const stdoutLimit = Math.floor((maxOutputBytes * stdoutBytes) / totalBytes)
  const stderrLimit = maxOutputBytes - stdoutLimit
  const boundedStdout = utf8Tail(stdout.text, stdoutLimit)
  const boundedStderr = utf8Tail(stderr.text, stderrLimit)
  return {
    stdout: boundedStdout.text,
    stderr: boundedStderr.text,
    truncated: true,
  }
}

function throwReason(signal: AbortSignal): never {
  throw signal.reason ?? new DOMException('Verification cancelled', 'AbortError')
}

function targetedVerifyInput(value: unknown): TargetedVerifyInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('targeted_verify arguments must be an object')
  }
  const input = value as { command?: unknown; args?: unknown }
  if (typeof input.command !== 'string' || !Array.isArray(input.args) || input.args.some(argument => typeof argument !== 'string')) {
    throw new TypeError('targeted_verify requires a command string and args string array')
  }
  return { command: input.command, args: input.args }
}

function evidenceText(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'Verification result unavailable.'
  const evidence = value as Record<string, unknown>
  const commandName = typeof evidence.commandName === 'string' ? evidence.commandName : 'unknown'
  const status = typeof evidence.status === 'string' ? evidence.status : 'unknown'
  const exitCode = typeof evidence.exitCode === 'number' ? String(evidence.exitCode) : 'none'
  const truncated = evidence.truncated === true
  const stdout = typeof evidence.stdout === 'string' ? evidence.stdout : ''
  const stderr = typeof evidence.stderr === 'string' ? evidence.stderr : ''
  return `Verification ${commandName}: ${status} (exit ${exitCode}; truncated ${truncated})\nstdout:\n${stdout}\nstderr:\n${stderr}`
}

/**
 * Executes only configured verification commands, records every admitted process outcome,
 * and returns bounded evidence. A caller cancellation is rethrown after the actual process
 * outcome is recorded; it is never relabeled as a timeout.
 */
export class VerificationService {
  constructor(private readonly options: VerificationServiceOptions) {}

  /**
   * Execute one configured command.
   * @param commandName - Deployment-configured command name.
   * @param args - Caller arguments admitted by that command's policy.
   * @param signal - Caller cancellation propagated to the managed process tree.
   * @returns Bounded evidence when the caller did not cancel the admitted attempt.
   */
  async run(commandName: string, args: readonly string[], signal: AbortSignal): Promise<VerificationEvidenceV1> {
    const request = validatedRequest(this.options.verification.commands, commandName, args)
    const { command, args: admittedArgs } = request
    if (signal.aborted) throwReason(signal)

    const timeoutController = new AbortController()
    let firstAbortCause: 'caller' | 'timeout' | undefined
    const rememberCallerAbort = () => {
      firstAbortCause ??= 'caller'
    }
    signal.addEventListener('abort', rememberCallerAbort, { once: true })
    const timer = setTimeout(() => {
      firstAbortCause ??= 'timeout'
      timeoutController.abort(new DOMException('Verification timed out', 'TimeoutError'))
    }, this.options.verification.timeoutMs)
    const combinedSignal = AbortSignal.any([signal, timeoutController.signal])
    const startedAt = Date.now()
    let handle: ReturnType<SubprocessRuntime['spawn']> | undefined
    let evidence: VerificationEvidenceV1

    try {
      handle = this.options.subprocess.spawn({
        argv: [command.executable, ...command.fixedArgs, ...admittedArgs],
        cwd: this.options.workspaceRoot,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: this.options.verification.maxOutputBytes },
          stderr: { maxBytes: this.options.verification.maxOutputBytes },
        },
        graceMs: Math.min(VERIFICATION_TERMINATION_GRACE_MS, this.options.verification.timeoutMs),
        signal: combinedSignal,
      })
      const outcome = await handle.done
      const output = boundEvidenceOutput(
        outputReader(handle.collected.stdout),
        outputReader(handle.collected.stderr),
        this.options.verification.maxOutputBytes,
      )
      evidence = {
        schemaVersion: 1,
        commandName: command.name,
        args: admittedArgs,
        exitCode: outcome.exitCode,
        status: firstAbortCause === 'timeout' ? 'timed-out' : outcome.exitCode === 0 ? 'passed' : 'failed',
        stdout: output.stdout,
        stderr: output.stderr,
        truncated: output.truncated,
        durationMs: Date.now() - startedAt,
      }
    } catch {
      const output = handle === undefined
        ? { stdout: '', stderr: '', truncated: false }
        : boundEvidenceOutput(
          outputReader(handle.collected.stdout),
          outputReader(handle.collected.stderr),
          this.options.verification.maxOutputBytes,
        )
      evidence = {
        schemaVersion: 1,
        commandName: command.name,
        args: admittedArgs,
        exitCode: null,
        status: 'spawn-error',
        stdout: output.stdout,
        stderr: output.stderr,
        truncated: output.truncated,
        durationMs: Date.now() - startedAt,
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', rememberCallerAbort)
      if (handle !== undefined) {
        handle.terminate()
        await handle.waitForExit()
      }
    }

    this.options.appendEvidence(evidence)
    if (firstAbortCause === 'caller') throwReason(signal)
    return evidence
  }
}

/**
 * Create the model-facing targeted verification tool. Its action admission happens before
 * any process spawn, and its generic presentation never exposes an unrestricted process stream.
 */
export function createTargetedVerificationTool(options: TargetedVerificationToolOptions): ToolDefinition {
  const workspaceRoot = trustedWorkspaceRoot(options.workspaceRoot)
  return {
    name: 'targeted_verify',
    description: 'Run one configured targeted verification command with approved arguments only.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
      },
      required: ['command', 'args'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          schemaVersion: { type: 'number' },
          commandName: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          exitCode: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          status: { type: 'string', enum: ['passed', 'failed', 'timed-out', 'spawn-error'] },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
          durationMs: { type: 'number' },
        },
        required: ['schemaVersion', 'commandName', 'args', 'exitCode', 'status', 'stdout', 'stderr', 'truncated', 'durationMs'],
      },
      render: (_args, value) => [{ type: 'text', text: evidenceText(value) }],
    },
    timeoutMs: options.verification.timeoutMs + VERIFICATION_CLEANUP_ALLOWANCE_MS,
    async execute(rawArgs, exec) {
      const input = targetedVerifyInput(rawArgs)
      const request = validatedRequest(options.verification.commands, input.command, input.args)
      if (exec.signal.aborted) throwReason(exec.signal)
      const session = exec.agent?.session
      if (session === undefined) throw new Error('targeted_verify requires an active agent session')
      const rootSessionId = session.header.parentSession ?? session.id
      const decision = options.budgetRegistry.forRootSession(rootSessionId).admitPluginTool('targeted_verify')
      if (!decision.allowed) {
        throw new Error(`targeted_verify rejected by budget: ${decision.code}`)
      }
      const service = new VerificationService({
        workspaceRoot,
        verification: options.verification,
        subprocess: options.subprocess,
        appendEvidence: evidence => { appendVerificationFinished(session, evidence) },
      })
      return service.run(request.command.name, request.args, exec.signal)
    },
    presentCall: rawArgs => {
      try {
        const input = targetedVerifyInput(rawArgs)
        return {
          card: 'generic',
          title: 'Run targeted verification',
          kind: 'execute',
          rawInput: { command: input.command, args: input.args },
        }
      } catch {
        // A malformed replay input receives the ToolRuntime generic fallback.
        return undefined
      }
    },
  }
}

/** Register the targeted verification tool in an effect so dispose and HMR unregister it. */
export function mountTargetedVerificationTool(
  ctx: Context,
  options: TargetedVerificationToolOptions,
): void {
  ctx.effect(() => ctx.tools.register(createTargetedVerificationTool(options)), 'ds-orchestrator: targeted verification')
}
