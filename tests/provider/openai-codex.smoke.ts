import { execFile, spawn } from 'node:child_process'
import { access, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const OPT_IN = 'DSH_RUN_OPENAI_CODEX_SMOKE'
const SKIP_MESSAGE = 'SKIP: set DSH_RUN_OPENAI_CODEX_SMOKE=1 to run the authorized OpenAI Codex smoke.'
const ACCEPTANCE_MARKER = 'DSH_V0_1_ACCEPTED'
const PINNED_HARNESS_COMMIT = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
const SMOKE_TIMEOUT_MS = 180_000
const PROFILE_PREFIX = 'dsh-v0.1-openai-codex-smoke-'
const SCRIPT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PROFILE_MODULES = join(SCRIPT_ROOT, 'profiles/v0.1/node_modules')
const execFileAsync = promisify(execFile)

interface CommandResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

interface JsonRecord {
  readonly type?: unknown
  readonly data?: unknown
}

interface ProviderSmokeRuntime {
  readonly fixtureParent?: string
  readonly execute?: (command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<CommandResult>
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function ancestors(start: string): string[] {
  const roots: string[] = []
  let current = resolve(start)
  while (true) {
    roots.push(current)
    const parent = dirname(current)
    if (parent === current) return roots
    current = parent
  }
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  )
}

async function gitCommonRoot(start: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', [
      '-c', 'core.hooksPath=/dev/null', '--no-optional-locks', 'rev-parse', '--path-format=absolute', '--git-common-dir',
    ], { cwd: start, env: sanitizedGitEnvironment(), timeout: 1_000 })
    const commonDir = stdout.trim()
    return commonDir === '' ? undefined : dirname(commonDir)
  } catch {
    return undefined
  }
}

async function isPinnedHarnessCheckout(candidate: string, expectedCommit: string): Promise<boolean> {
  try {
    const environment = sanitizedGitEnvironment()
    const canonicalCandidate = await realpath(candidate)
    const { stdout: topLevelOutput } = await execFileAsync('git', [
      '-c', 'core.hooksPath=/dev/null', '--no-optional-locks', 'rev-parse', '--path-format=absolute', '--show-toplevel',
    ], { cwd: canonicalCandidate, env: environment, timeout: 1_000 })
    const topLevel = topLevelOutput.trim()
    if (topLevel === '' || await realpath(topLevel) !== canonicalCandidate) return false

    const { stdout: headOutput } = await execFileAsync('git', [
      '-c', 'core.hooksPath=/dev/null', '--no-optional-locks', 'rev-parse', '--verify', 'HEAD^{commit}',
    ], { cwd: canonicalCandidate, env: environment, timeout: 1_000 })
    if (headOutput.trim() !== expectedCommit) return false

    const { stdout: statusOutput } = await execFileAsync('git', [
      '-c', 'core.hooksPath=/dev/null', '--no-optional-locks', 'status', '--porcelain', '--untracked-files=no',
    ], { cwd: canonicalCandidate, env: environment, timeout: 1_000 })
    if (statusOutput !== '') return false

    const cliPath = join(canonicalCandidate, 'apps/cli/src/bin.ts')
    const [{ stdout: committedCli }, worktreeCli] = await Promise.all([
      execFileAsync('git', [
        '-c', 'core.hooksPath=/dev/null', '--no-optional-locks', 'show', 'HEAD:apps/cli/src/bin.ts',
      ], { cwd: canonicalCandidate, env: environment, timeout: 1_000, encoding: 'buffer' }),
      readFile(cliPath),
    ])
    return worktreeCli.equals(committedCli)
  } catch {
    return false
  }
}

export async function findHarnessRoot(searchFrom = SCRIPT_ROOT, expectedCommit = PINNED_HARNESS_COMMIT): Promise<string> {
  const configured = process.env.DSH_HARNESS_ROOT
  if (configured !== undefined) {
    const candidate = resolve(configured)
    if (await isPinnedHarnessCheckout(candidate, expectedCommit)) return candidate
    throw new Error(`Harness source checkout is unavailable at pinned commit ${expectedCommit}; set DSH_HARNESS_ROOT to the pinned deepseek-harness checkout.`)
  }

  const ancestorRoots = ancestors(searchFrom)
  const commonRoot = await gitCommonRoot(searchFrom)
  const roots = commonRoot === undefined
    ? ancestorRoots
    : [commonRoot, ...ancestorRoots.filter(root => root !== commonRoot)]
  const candidates = roots.map(root => join(root, 'upstream/deepseek-harness'))
  for (const candidate of candidates) {
    if (await isPinnedHarnessCheckout(candidate, expectedCommit)) return candidate
  }
  throw new Error(`Harness source checkout is unavailable at pinned commit ${expectedCommit}; set DSH_HARNESS_ROOT to the pinned deepseek-harness checkout.`)
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const append = (target: 'stdout' | 'stderr', chunk: string) => {
      const value = target === 'stdout' ? stdout : stderr
      const clipped = (value + chunk).slice(0, 262_144)
      if (target === 'stdout') stdout = clipped
      else stderr = clipped
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { append('stdout', chunk) })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { append('stderr', chunk) })
    const timer = setTimeout(() => { child.kill('SIGTERM') }, SMOKE_TIMEOUT_MS)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', code => {
      clearTimeout(timer)
      resolveRun({ code, stdout, stderr })
    })
  })
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

async function recordsFrom(sessionRoot: string): Promise<readonly JsonRecord[]> {
  if (!await exists(sessionRoot)) return []
  const files = (await listFiles(sessionRoot)).filter(path => path.endsWith('.jsonl'))
  const records: JsonRecord[] = []
  for (const path of files) {
    const content = await readFile(path, 'utf8')
    for (const line of content.split('\n')) {
      if (line.trim() === '') continue
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) records.push(parsed as JsonRecord)
    }
  }
  return records
}

function eventOf(records: readonly JsonRecord[], type: string): JsonRecord | undefined {
  return records.find(record => record.type === type)
}

function assertTerminalOutput(label: string, result: CommandResult): void {
  if (result.code !== 0 || result.stdout.trim() === '') {
    throw new Error(`${label} smoke did not produce terminal output.`)
  }
}

function assertDirectTerminalOutput(result: CommandResult): void {
  assertTerminalOutput('Direct', result)
  if (!result.stdout.includes(ACCEPTANCE_MARKER)) {
    throw new Error(`Direct smoke did not produce ${ACCEPTANCE_MARKER}.`)
  }
}

function assertDirectEvidence(records: readonly JsonRecord[]): void {
  const event = eventOf(records, 'dsh-plugin/run-started')
  if (event === undefined || typeof event.data !== 'object' || event.data === null) {
    throw new Error('Direct smoke did not record dsh-plugin/run-started.')
  }
  const data = event.data as Record<string, unknown>
  if (data.mode !== 'direct' || data.provider !== 'openai-codex') {
    throw new Error('Direct smoke did not resolve the official openai-codex route.')
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function assertNoRawChildMaterial(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoRawChildMaterial(item)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, child] of Object.entries(value)) {
    if (key === 'transcript' || key === 'diagnostic') {
      throw new Error('Single Worker smoke exposed raw child material to the parent session.')
    }
    assertNoRawChildMaterial(child)
  }
}

function assertParentHandoffProjection(records: readonly JsonRecord[], handoff: Record<string, unknown>): void {
  const contexts = records.filter(entry => {
    if (entry.type !== 'user/message') return false
    try {
      const data = record(entry.data, 'Parent context')
      const source = record(data.source, 'Parent context source')
      return source.kind === 'plugin' && source.plugin === 'ds-orchestrator' && source.form === 'notice'
    } catch {
      return false
    }
  })
  if (contexts.length !== 1) throw new Error('Single Worker smoke did not record exactly one parent Handoff context.')
  const context = record(contexts[0].data, 'Parent context')
  if (!Array.isArray(context.content) || context.content.length !== 1) {
    throw new Error('Single Worker smoke parent context is not a bounded Handoff projection.')
  }
  const content = record(context.content[0], 'Parent context content')
  if (content.type !== 'text' || typeof content.text !== 'string') {
    throw new Error('Single Worker smoke parent context is not text.')
  }
  let projection: unknown
  try {
    projection = JSON.parse(content.text)
  } catch {
    throw new Error('Single Worker smoke parent context is not JSON.')
  }
  const expected = {
    status: handoff.status,
    summary: handoff.summary,
    changedFiles: handoff.changedFiles,
    decisions: handoff.decisions,
    verification: handoff.verification,
    blockers: handoff.blockers,
  }
  if (JSON.stringify(projection) !== JSON.stringify(expected)) {
    throw new Error('Single Worker smoke parent context is not the bounded Handoff projection.')
  }
}

function assertSingleWorkerEvidence(records: readonly JsonRecord[]): void {
  const event = eventOf(records, 'dsh-plugin/worker-finished')
  if (event === undefined || typeof event.data !== 'object' || event.data === null) {
    throw new Error('Single Worker smoke did not record dsh-plugin/worker-finished.')
  }
  const data = record(event.data, 'Single Worker event')
  const handoff = data.handoff
  if (typeof handoff !== 'object' || handoff === null || Array.isArray(handoff)) {
    throw new Error('Single Worker smoke did not record HandoffV1.')
  }
  const handoffRecord = handoff as Record<string, unknown>
  const keys = Object.keys(handoffRecord).sort()
  const expectedKeys = ['blockers', 'changedFiles', 'decisions', 'schemaVersion', 'status', 'summary', 'verification']
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || handoffRecord.schemaVersion !== 1) {
    throw new Error('Single Worker smoke recorded a child result outside HandoffV1.')
  }
  if (handoffRecord.status !== 'completed' || typeof handoffRecord.summary !== 'string'
    || !handoffRecord.summary.includes(ACCEPTANCE_MARKER)) {
    throw new Error(`Single Worker smoke did not complete with ${ACCEPTANCE_MARKER}.`)
  }
  assertNoRawChildMaterial(records)
  assertParentHandoffProjection(records, handoffRecord)
}

function profilePatch(mode: 'direct' | 'single-worker', workspaceRoot: string, sessionRoot: string): string {
  const maxWorkers = mode === 'direct' ? 0 : 1
  return [
    '- id: agent-default-model',
    '  config:',
    '    provider: openai-codex',
    '    model: gpt-5.6-codex',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      openai-codex: {}',
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: ${yamlString(sessionRoot)}`,
    '    compression: none',
    '    packChunks: false',
    '- id: ds-orchestrator',
    '  config:',
    `    workspaceRoot: ${yamlString(workspaceRoot)}`,
    `    mode: ${mode}`,
    '    worker:',
    '      provider: openai-codex',
    '      model: gpt-5.6-codex',
    '      maxTokens: 2048',
    '    budgets:',
    `      maxWorkers: ${maxWorkers}`,
    '      maxPluginToolActions: 4',
    '      toolTimeoutMs: 60000',
    '    verification:',
    '      commands: []',
    '      timeoutMs: 60000',
    '      maxOutputBytes: 4096',
    '',
  ].join('\n')
}

async function installSmokeProfile(dshHome: string, profileName: string, fixtureRoot: string, sessionRoot: string): Promise<string> {
  const profileDir = join(dshHome, 'profiles', profileName)
  if (await exists(profileDir)) throw new Error('The temporary provider-smoke profile already exists; retry after the previous smoke exits.')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: '@ds-plugins/openai-codex-smoke-profile',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', '@ds-plugins/dsh-orchestrator'] } },
  }, null, 2) + '\n')
  await symlink(PROFILE_MODULES, join(profileDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(profileDir, 'cordis.patch.yml'), profilePatch('direct', fixtureRoot, sessionRoot))
  return profileDir
}

async function removeProfile(profileDir: string): Promise<void> {
  try {
    const status = await lstat(profileDir)
    if (status.isDirectory()) await rm(profileDir, { recursive: true, force: true })
  } catch {
    // A failed cleanup must not surface token-bearing child-process output.
  }
}

/** Execute the smoke after the caller has validated the Harness checkout boundary. */
export async function runProviderSmoke(harnessRoot: string, dshHome: string, runtime: ProviderSmokeRuntime = {}): Promise<void> {
  const fixtureRoot = await mkdtemp(join(runtime.fixtureParent ?? tmpdir(), 'dsh-openai-codex-smoke-'))
  const execute = runtime.execute ?? run
  const sessionRoot = join(fixtureRoot, 'sessions')
  const profileName = `${PROFILE_PREFIX}${process.pid}`
  const profileDir = await installSmokeProfile(resolve(dshHome), profileName, fixtureRoot, sessionRoot)
  const commandEnv = {
    ...process.env,
    DSH_HOME: resolve(dshHome),
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PERMISSION_MODE: 'read-only',
  }
  const cli = join(harnessRoot, 'apps/cli/src/bin.ts')
  try {
    await writeFile(join(fixtureRoot, 'acceptance-task.txt'), 'The required phrase is DSH_V0_1_ACCEPTED.\n')
    const direct = await execute(process.execPath, ['--expose-internals', '--import', 'tsx/esm', cli, '--profile', profileName,
      `Read acceptance-task.txt and reply exactly ${ACCEPTANCE_MARKER}. Do not modify files.`], fixtureRoot, commandEnv)
    assertDirectTerminalOutput(direct)
    assertDirectEvidence(await recordsFrom(sessionRoot))

    await rm(sessionRoot, { recursive: true, force: true })
    await writeFile(join(profileDir, 'cordis.patch.yml'), profilePatch('single-worker', fixtureRoot, sessionRoot))
    const worker = await execute(process.execPath, ['--expose-internals', '--import', 'tsx/esm', cli, '--profile', profileName,
      `Call delegate_worker exactly once with allowedTools ["read"]. Ask it to read acceptance-task.txt and return only a completed HandoffV1 whose summary includes ${ACCEPTANCE_MARKER}. Then give a brief final answer.`], fixtureRoot, commandEnv)
    assertTerminalOutput('Single Worker', worker)
    assertSingleWorkerEvidence(await recordsFrom(sessionRoot))
  } finally {
    await removeProfile(profileDir)
    await rm(fixtureRoot, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const dshHome = process.env.DSH_HOME
  if (dshHome === undefined || dshHome.trim() === '') {
    throw new Error('DSH_HOME must point at the existing official OpenAI Codex authorization store.')
  }
  if (!await exists(PROFILE_MODULES)) {
    throw new Error('The v0.1 profile dependencies are unavailable; run pnpm install before the provider smoke.')
  }
  const harnessRoot = await findHarnessRoot()
  await runProviderSmoke(harnessRoot, dshHome)
  process.stdout.write('PASS: official openai-codex Direct and Single Worker smoke completed.\n')
}

if (process.env[OPT_IN] !== '1') {
  process.stdout.write(`${SKIP_MESSAGE}\n`)
} else {
  void main().catch(() => {
    process.stderr.write('OpenAI Codex smoke failed without exposing provider credentials or provider output.\n')
    process.exitCode = 1
  })
}
