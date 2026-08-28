import { spawn } from 'node:child_process'
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OPT_IN = 'DSH_RUN_OPENAI_CODEX_SMOKE'
const SKIP_MESSAGE = 'SKIP: set DSH_RUN_OPENAI_CODEX_SMOKE=1 to run the authorized OpenAI Codex smoke.'
const SMOKE_TIMEOUT_MS = 180_000
const PROFILE_PREFIX = 'dsh-v0.1-openai-codex-smoke-'
const SCRIPT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PROFILE_MODULES = join(SCRIPT_ROOT, 'profiles/v0.1/node_modules')

interface CommandResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

interface JsonRecord {
  readonly type?: unknown
  readonly data?: unknown
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

export async function findHarnessRoot(): Promise<string> {
  const configured = process.env.DSH_HARNESS_ROOT
  const candidates = configured === undefined
    ? [
        join(SCRIPT_ROOT, 'upstream/deepseek-harness'),
        join(dirname(SCRIPT_ROOT), 'upstream/deepseek-harness'),
        join(dirname(dirname(SCRIPT_ROOT)), 'upstream/deepseek-harness'),
      ]
    : [resolve(configured)]
  for (const candidate of candidates) {
    if (await exists(join(candidate, 'apps/cli/src/bin.ts'))) return candidate
  }
  throw new Error('Harness source checkout is unavailable; set DSH_HARNESS_ROOT to the pinned deepseek-harness checkout.')
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

function assertSingleWorkerEvidence(records: readonly JsonRecord[]): void {
  const event = eventOf(records, 'dsh-plugin/worker-finished')
  if (event === undefined || typeof event.data !== 'object' || event.data === null) {
    throw new Error('Single Worker smoke did not record dsh-plugin/worker-finished.')
  }
  const data = event.data as Record<string, unknown>
  const handoff = data.handoff
  if (typeof handoff !== 'object' || handoff === null || Array.isArray(handoff)) {
    throw new Error('Single Worker smoke did not record HandoffV1.')
  }
  const keys = Object.keys(handoff).sort()
  const expectedKeys = ['blockers', 'changedFiles', 'decisions', 'schemaVersion', 'status', 'summary', 'verification']
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || (handoff as Record<string, unknown>).schemaVersion !== 1) {
    throw new Error('Single Worker smoke recorded a child result outside HandoffV1.')
  }
  const raw = JSON.stringify(handoff)
  if (raw.includes('transcript') || raw.includes('diagnostic') || raw.includes('authorization')) {
    throw new Error('Single Worker smoke exposed non-Handoff child material to the parent evidence.')
  }
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

async function main(): Promise<void> {
  const dshHome = process.env.DSH_HOME
  if (dshHome === undefined || dshHome.trim() === '') {
    throw new Error('DSH_HOME must point at the existing official OpenAI Codex authorization store.')
  }
  if (!await exists(PROFILE_MODULES)) {
    throw new Error('The v0.1 profile dependencies are unavailable; run pnpm install before the provider smoke.')
  }
  const harnessRoot = await findHarnessRoot()
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-smoke-'))
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
    const direct = await run(process.execPath, ['--expose-internals', '--import', 'tsx/esm', cli, '--profile', profileName,
      'Read acceptance-task.txt and reply with the required phrase. Do not modify files.'], fixtureRoot, commandEnv)
    assertTerminalOutput('Direct', direct)
    assertDirectEvidence(await recordsFrom(sessionRoot))

    await rm(sessionRoot, { recursive: true, force: true })
    await writeFile(join(profileDir, 'cordis.patch.yml'), profilePatch('single-worker', fixtureRoot, sessionRoot))
    const worker = await run(process.execPath, ['--expose-internals', '--import', 'tsx/esm', cli, '--profile', profileName,
      'Call delegate_worker exactly once with allowedTools ["read_file"]. Ask it to read acceptance-task.txt and return only HandoffV1. Then give a brief final answer.'], fixtureRoot, commandEnv)
    assertTerminalOutput('Single Worker', worker)
    assertSingleWorkerEvidence(await recordsFrom(sessionRoot))
    process.stdout.write('PASS: official openai-codex Direct and Single Worker smoke completed.\n')
  } finally {
    await removeProfile(profileDir)
    await rm(fixtureRoot, { recursive: true, force: true })
  }
}

if (process.env[OPT_IN] !== '1') {
  process.stdout.write(`${SKIP_MESSAGE}\n`)
} else {
  void main().catch(() => {
    process.stderr.write('OpenAI Codex smoke failed without exposing provider credentials or provider output.\n')
    process.exitCode = 1
  })
}
