import type { OrchestratorConfig, VerificationAllowedArgs, VerificationCommand } from './types.js'

/** Maximum number of plugin-owned tool actions admitted in one run. */
export const MAX_PLUGIN_TOOL_ACTIONS = 32

/** Maximum finite timeout for one plugin-owned external action. */
export const MAX_TOOL_TIMEOUT_MS = 600_000

/** Maximum bytes retained from one verification command's combined output. */
export const MAX_VERIFICATION_OUTPUT_BYTES = 1_048_576

/** Maximum UTF-8 byte length for one handoff string field. */
export const MAX_HANDOFF_STRING_BYTES = 16_384

/** Maximum items retained in a handoff array field. */
export const MAX_HANDOFF_ITEMS = 128

type RecordValue = Record<string, unknown>

function fail(path: string, message: string): never {
  throw new TypeError(`${path} ${message}`)
}

function record(value: unknown, path: string): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'must be an object')
  }
  return value as RecordValue
}

function onlyKeys(value: RecordValue, path: string, keys: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${path}.${key}`, 'is not supported')
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty string')
  return value
}

function positiveInteger(value: unknown, path: string, maximum?: number): number {
  if (!Number.isInteger(value) || typeof value !== 'number' || value <= 0) {
    fail(path, 'must be a positive integer')
  }
  if (maximum !== undefined && value > maximum) fail(path, `must not exceed ${maximum}`)
  return value
}

function verificationCommand(value: unknown, index: number): VerificationCommand {
  const path = `verification.commands[${index}]`
  const command = record(value, path)
  onlyKeys(command, path, ['name', 'executable', 'fixedArgs', 'allowedArgs'])
  const name = nonEmptyString(command.name, `${path}.name`)
  const executable = nonEmptyString(command.executable, `${path}.executable`)
  if (/\s/u.test(executable)) fail(`${path}.executable`, 'must be one path/name token')
  if (!Array.isArray(command.fixedArgs)) fail(`${path}.fixedArgs`, 'must be an array of literal arguments')
  const fixedArgs = command.fixedArgs.map((argument, argumentIndex) =>
    nonEmptyString(argument, `${path}.fixedArgs[${argumentIndex}]`),
  )
  const allowedArgs = command.allowedArgs
  if (allowedArgs !== 'none' && allowedArgs !== 'orchestrator-test-paths') {
    fail(`${path}.allowedArgs`, 'must be "none" or "orchestrator-test-paths"')
  }
  return { name, executable, fixedArgs, allowedArgs: allowedArgs as VerificationAllowedArgs }
}

/**
 * Validate deployment configuration before the plugin starts.
 * @param value - Raw Cordis configuration.
 * @returns The validated configuration without unknown fields.
 * @throws {TypeError} When a field violates the v0.1 configuration rules.
 */
export function parseConfig(value: unknown): OrchestratorConfig {
  const config = record(value, 'config')
  onlyKeys(config, 'config', ['workspaceRoot', 'mode', 'worker', 'budgets', 'verification'])

  const workspaceRoot = nonEmptyString(config.workspaceRoot, 'workspaceRoot')
  if (workspaceRoot.includes('\0')) fail('workspaceRoot', 'must not contain NUL bytes')

  const mode = config.mode
  if (mode !== 'direct' && mode !== 'single-worker') fail('mode', 'must be "direct" or "single-worker"')

  const worker = record(config.worker, 'worker')
  onlyKeys(worker, 'worker', ['provider', 'model', 'reasoningEffort', 'maxTokens'])
  const provider = nonEmptyString(worker.provider, 'worker.provider')
  const model = nonEmptyString(worker.model, 'worker.model')
  const reasoningEffort = worker.reasoningEffort === undefined
    ? undefined
    : nonEmptyString(worker.reasoningEffort, 'worker.reasoningEffort')
  const maxTokens = positiveInteger(worker.maxTokens, 'worker.maxTokens')

  const budgets = record(config.budgets, 'budgets')
  onlyKeys(budgets, 'budgets', ['maxWorkers', 'maxPluginToolActions', 'toolTimeoutMs'])
  const maxWorkers = budgets.maxWorkers
  if (maxWorkers !== 0 && maxWorkers !== 1) fail('budgets.maxWorkers', 'must be 0 or 1')
  if (mode === 'direct' && maxWorkers !== 0) fail('mode "direct"', 'requires budgets.maxWorkers to be 0')
  if (mode === 'single-worker' && maxWorkers !== 1) {
    fail('mode "single-worker"', 'requires budgets.maxWorkers to be 1')
  }
  const maxPluginToolActions = positiveInteger(
    budgets.maxPluginToolActions,
    'budgets.maxPluginToolActions',
    MAX_PLUGIN_TOOL_ACTIONS,
  )
  const toolTimeoutMs = positiveInteger(budgets.toolTimeoutMs, 'budgets.toolTimeoutMs', MAX_TOOL_TIMEOUT_MS)

  const verification = record(config.verification, 'verification')
  onlyKeys(verification, 'verification', ['commands', 'timeoutMs', 'maxOutputBytes'])
  if (!Array.isArray(verification.commands)) fail('verification.commands', 'must be an array')
  const commands = verification.commands.map(verificationCommand)
  const commandNames = new Set<string>()
  for (const command of commands) {
    if (commandNames.has(command.name)) {
      fail('verification.commands', `contains duplicate command name ${JSON.stringify(command.name)}`)
    }
    commandNames.add(command.name)
  }
  const timeoutMs = positiveInteger(verification.timeoutMs, 'verification.timeoutMs', MAX_TOOL_TIMEOUT_MS)
  const maxOutputBytes = positiveInteger(
    verification.maxOutputBytes,
    'verification.maxOutputBytes',
    MAX_VERIFICATION_OUTPUT_BYTES,
  )

  return {
    workspaceRoot,
    mode,
    worker: { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }), maxTokens },
    budgets: { maxWorkers, maxPluginToolActions, toolTimeoutMs },
    verification: { commands, timeoutMs, maxOutputBytes },
  }
}

/** Cordis standard-schema entry that delegates loading validation to {@link parseConfig}. */
export const Config = {
  '~standard': {
    version: 1 as const,
    vendor: '@ds-plugins/dsh-orchestrator',
    validate(value: unknown) {
      try {
        return { value: parseConfig(value) }
      } catch (error) {
        return {
          issues: [{ message: error instanceof Error ? error.message : 'invalid configuration' }],
        }
      }
    },
  },
}
