import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { findHarnessRoot, runProviderSmoke } from './openai-codex.smoke.ts'

const scriptPath = fileURLToPath(new URL('./openai-codex.smoke.ts', import.meta.url))
const profileManifestPath = fileURLToPath(new URL('../../profiles/v0.1/package.json', import.meta.url))
const execFileAsync = promisify(execFile)

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args])
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args])
  return stdout.trim()
}

async function initHarnessRepository(root: string, trackCli = true): Promise<string> {
  await mkdir(dirname(root), { recursive: true })
  await runGit(dirname(root), ['init', '--initial-branch=main', root])
  await runGit(root, ['config', 'user.email', 'smoke@example.invalid'])
  await runGit(root, ['config', 'user.name', 'Provider smoke fixture'])
  await mkdir(join(root, 'apps', 'cli', 'src'), { recursive: true })
  await writeFile(join(root, 'apps', 'cli', 'src', 'bin.ts'), 'process.stdout.write("trusted harness\\n")\n')
  await writeFile(join(root, 'README.md'), 'trusted harness fixture\n')
  await runGit(root, ['add', 'README.md'])
  if (trackCli) await runGit(root, ['add', 'apps/cli/src/bin.ts'])
  await runGit(root, ['commit', '-m', 'trusted harness fixture'])
  return gitOutput(root, ['rev-parse', 'HEAD'])
}

function runKeylessSmoke(): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', scriptPath], {
      env: { ...process.env, DSH_RUN_OPENAI_CODEX_SMOKE: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

type FakeSmokeScenario = 'require-read' | 'direct-wrong-marker' | 'failed-handoff' | 'blocked-handoff' | 'context-leak'

interface FakeSmokeResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly trace: string
}

function capturedTask(trace: string, direct: boolean): string {
  const entry = trace.split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as { direct?: unknown; task?: unknown })
    .find(entry => entry.direct === direct)
  if (typeof entry?.task !== 'string') throw new Error(`Missing ${direct ? 'Direct' : 'Single Worker'} fake CLI trace.`)
  return entry.task
}

const fakeCli = `
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const profileIndex = process.argv.indexOf('--profile')
const profile = process.argv[profileIndex + 1]
const task = process.argv.at(-1) ?? ''
const patch = await readFile(join(process.env.DSH_HOME, 'profiles', profile, 'cordis.patch.yml'), 'utf8')
const rootLine = patch.match(/^\\s*root:\\s*(.+)$/m)
if (rootLine === null) throw new Error('missing fake session root')
const sessionRoot = JSON.parse(rootLine[1])
const direct = patch.includes('mode: direct')
const scenario = process.env.DSH_FAKE_SMOKE_SCENARIO
if (process.env.DSH_FAKE_CAPTURE_PATH !== undefined) {
  await appendFile(process.env.DSH_FAKE_CAPTURE_PATH, JSON.stringify({ direct, task }) + '\\n')
}
await mkdir(sessionRoot, { recursive: true })

if (direct) {
  await writeFile(join(sessionRoot, 'direct.jsonl'), JSON.stringify({
    type: 'dsh-plugin/run-started',
    data: { mode: 'direct', provider: 'openai-codex', model: 'gpt-5.6-codex' },
  }) + '\\n')
  process.stdout.write(scenario === 'direct-wrong-marker' ? 'WRONG_TERMINAL_OUTPUT\\n' : 'DSH_V0_1_ACCEPTED\\n')
} else {
  if (scenario === 'require-read' && !task.includes('allowedTools ["read"]')) {
    process.exitCode = 2
  } else {
    const status = scenario === 'blocked-handoff' ? 'blocked' : scenario === 'failed-handoff' ? 'failed' : 'completed'
    const handoff = {
      schemaVersion: 1,
      status,
      summary: status === 'completed' ? 'DSH_V0_1_ACCEPTED' : 'Worker did not complete.',
      changedFiles: [],
      decisions: [],
      verification: [],
      blockers: status === 'completed' ? [] : ['fixture failure'],
    }
    const projection = JSON.stringify({
      status: handoff.status,
      summary: handoff.summary,
      changedFiles: handoff.changedFiles,
      decisions: handoff.decisions,
      verification: handoff.verification,
      blockers: handoff.blockers,
    })
    const parentContext = scenario === 'context-leak'
      ? { content: [{ type: 'text', text: projection }], source: { kind: 'plugin', plugin: 'ds-orchestrator', form: 'notice' }, transcript: 'SECRET_TRANSCRIPT_MARKER', diagnostic: 'SECRET_DIAGNOSTIC_MARKER' }
      : { content: [{ type: 'text', text: projection }], source: { kind: 'plugin', plugin: 'ds-orchestrator', form: 'notice' } }
    await writeFile(join(sessionRoot, 'worker.jsonl'), [
      JSON.stringify({ type: 'dsh-plugin/worker-finished', data: { childSessionId: 'fake-child', handoff } }),
      JSON.stringify({ type: 'user/message', data: parentContext }),
    ].join('\\n') + '\\n')
    process.stdout.write('DSH_V0_1_ACCEPTED\\n')
  }
}
`

function executeFakeCli(cli: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}> {
  return new Promise((resolveRun, reject) => {
    const profileIndex = args.indexOf('--profile')
    if (profileIndex < 0) return reject(new Error('missing provider-smoke profile argument'))
    const child = spawn(process.execPath, ['--experimental-strip-types', cli, ...args.slice(profileIndex)], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolveRun({ code, stdout, stderr }))
  })
}

async function runAuthorizedFakeSmoke(scenario: FakeSmokeScenario): Promise<FakeSmokeResult> {
  const fakeHarness = await mkdtemp(join(tmpdir(), 'dsh-provider-smoke-harness-'))
  const fakeHome = await mkdtemp(join(tmpdir(), 'dsh-provider-smoke-home-'))
  const capturePath = join(fakeHarness, 'capture.jsonl')
  const previousScenario = process.env.DSH_FAKE_SMOKE_SCENARIO
  const previousCapturePath = process.env.DSH_FAKE_CAPTURE_PATH
  try {
    const cli = join(fakeHarness, 'apps/cli/src/bin.ts')
    await mkdir(dirname(cli), { recursive: true })
    await writeFile(cli, fakeCli)
    const installedHarness = await findHarnessRoot()
    process.env.DSH_FAKE_SMOKE_SCENARIO = scenario
    process.env.DSH_FAKE_CAPTURE_PATH = capturePath
    let code = 0
    let stderr = ''
    try {
      await runProviderSmoke(fakeHarness, fakeHome, {
        fixtureParent: installedHarness,
        execute: (_command, args, cwd, env) => executeFakeCli(cli, args, cwd, env),
      })
    } catch (error) {
      code = 1
      stderr = error instanceof Error ? error.message : String(error)
    }
    const trace = await readFile(capturePath, 'utf8').catch(() => '')
    return { code, stdout: '', stderr, trace }
  } finally {
    if (previousScenario === undefined) delete process.env.DSH_FAKE_SMOKE_SCENARIO
    else process.env.DSH_FAKE_SMOKE_SCENARIO = previousScenario
    if (previousCapturePath === undefined) delete process.env.DSH_FAKE_CAPTURE_PATH
    else process.env.DSH_FAKE_CAPTURE_PATH = previousCapturePath
    await rm(fakeHarness, { recursive: true, force: true })
    await rm(fakeHome, { recursive: true, force: true })
  }
}

describe('openai-codex provider smoke command', () => {
  it('skips without loading provider code until the explicit opt-in is set', async () => {
    const result = await runKeylessSmoke()

    expect(result).toEqual({
      code: 0,
      stdout: 'SKIP: set DSH_RUN_OPENAI_CODEX_SMOKE=1 to run the authorized OpenAI Codex smoke.\n',
      stderr: '',
    })
  })

  it('finds the repository harness checkout when launched from this linked worktree', async () => {
    const checkout = resolve(fileURLToPath(new URL('../../../../upstream/deepseek-harness', import.meta.url)))
    expect(existsSync(resolve(checkout, 'apps/cli/src/bin.ts'))).toBe(true)
    await expect(findHarnessRoot()).resolves.toBe(checkout)
  })

  it('declares the official headless bundle required by the opt-in smoke profile', () => {
    const manifest = JSON.parse(readFileSync(profileManifestPath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.['@deepseek-ai/dsh-headless']).toBe('0.1.1-rc.2')
  })

  it('uses the pinned read tool in the actual single-worker tool filter', async () => {
    const result = await runAuthorizedFakeSmoke('require-read')
    expect(result.code, `${result.stderr}; trace=${result.trace}`).toBe(0)
    expect(capturedTask(result.trace, false)).toContain('allowedTools ["read"]')
    expect(capturedTask(result.trace, false)).not.toContain('read_file')
  })

  it('rejects Direct output that omits the acceptance marker', async () => {
    await expect(runAuthorizedFakeSmoke('direct-wrong-marker')).resolves.toMatchObject({
      code: 1,
      trace: expect.stringContaining('{"direct":true'),
    })
  })

  it.each(['failed-handoff', 'blocked-handoff'] as const)(
    'rejects a %s worker handoff even when the CLI exits successfully', async scenario => {
      await expect(runAuthorizedFakeSmoke(scenario)).resolves.toMatchObject({
        code: 1,
        trace: expect.stringContaining('{"direct":false'),
      })
    })

  it('rejects transcript and diagnostic data outside the bounded parent handoff projection', async () => {
    await expect(runAuthorizedFakeSmoke('context-leak')).resolves.toMatchObject({
      code: 1,
      trace: expect.stringContaining('{"direct":false'),
    })
  })

  it('finds a Harness checkout from an arbitrary external linked-worktree layout', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-linked-worktree-'))
    const linkedWorktree = join(fixtureRoot, 'external', 'worktrees', 'arbitrary', 'checkout')
    const repository = join(fixtureRoot, 'repository')
    const harness = join(repository, 'upstream', 'deepseek-harness')
    const decoy = join(fixtureRoot, 'external', 'worktrees', 'arbitrary', 'upstream', 'deepseek-harness')
    const previousHarnessRoot = process.env.DSH_HARNESS_ROOT
    try {
      await runGit(fixtureRoot, ['init', '--initial-branch=main', 'repository'])
      await runGit(repository, ['config', 'user.email', 'smoke@example.invalid'])
      await runGit(repository, ['config', 'user.name', 'Provider smoke fixture'])
      await writeFile(join(repository, 'README.md'), 'fixture\n')
      await runGit(repository, ['add', 'README.md'])
      await runGit(repository, ['commit', '-m', 'fixture'])
      await mkdir(dirname(linkedWorktree), { recursive: true })
      await runGit(repository, ['worktree', 'add', '--detach', linkedWorktree, 'HEAD'])
      const expectedCommit = await initHarnessRepository(harness)
      await runGit(fixtureRoot, ['clone', '--no-hardlinks', harness, decoy])
      delete process.env.DSH_HARNESS_ROOT
      const discover = findHarnessRoot as unknown as (searchFrom: string, expectedCommit: string) => Promise<string>
      await expect(discover(linkedWorktree, expectedCommit)).resolves.toBe(harness)
    } finally {
      if (previousHarnessRoot === undefined) delete process.env.DSH_HARNESS_ROOT
      else process.env.DSH_HARNESS_ROOT = previousHarnessRoot
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('rejects a Harness candidate that has a CLI entry but not the pinned commit', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-unpinned-harness-'))
    const harness = join(fixtureRoot, 'upstream', 'deepseek-harness')
    const candidate = join(harness, 'apps', 'cli', 'src', 'bin.ts')
    const previousHarnessRoot = process.env.DSH_HARNESS_ROOT
    try {
      await mkdir(dirname(candidate), { recursive: true })
      await writeFile(candidate, '')
      process.env.DSH_HARNESS_ROOT = harness
      await expect(findHarnessRoot(fixtureRoot)).rejects.toThrow('pinned deepseek-harness checkout')
    } finally {
      if (previousHarnessRoot === undefined) delete process.env.DSH_HARNESS_ROOT
      else process.env.DSH_HARNESS_ROOT = previousHarnessRoot
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('does not inherit Git repository-location, object, or config variables for a Harness override', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-git-environment-'))
    const harness = join(fixtureRoot, 'upstream', 'deepseek-harness')
    const candidate = join(harness, 'apps', 'cli', 'src', 'bin.ts')
    const pinnedHarness = await findHarnessRoot()
    expect(existsSync(join(pinnedHarness, '.git'))).toBe(true)
    expect(await gitOutput(pinnedHarness, ['rev-parse', 'HEAD']))
      .toBe('b150a551b8d465e31e418e1b2eaf5e79bbb7d28e')
    const preserved = new Map<string, string | undefined>()
    const injected = {
      GIT_DIR: join(pinnedHarness, '.git'),
      GIT_WORK_TREE: pinnedHarness,
      GIT_COMMON_DIR: join(pinnedHarness, '.git'),
      GIT_OBJECT_DIRECTORY: join(pinnedHarness, '.git', 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(pinnedHarness, '.git', 'objects'),
      GIT_CONFIG_GLOBAL: join(fixtureRoot, 'malicious.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    }
    const previousHarnessRoot = process.env.DSH_HARNESS_ROOT
    try {
      await mkdir(dirname(candidate), { recursive: true })
      await writeFile(candidate, '')
      for (const [key, value] of Object.entries(injected)) {
        preserved.set(key, process.env[key])
        process.env[key] = value
      }
      process.env.DSH_HARNESS_ROOT = harness
      await expect(findHarnessRoot(fixtureRoot)).rejects.toThrow('pinned deepseek-harness checkout')
    } finally {
      for (const [key, value] of preserved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      if (previousHarnessRoot === undefined) delete process.env.DSH_HARNESS_ROOT
      else process.env.DSH_HARNESS_ROOT = previousHarnessRoot
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('rejects a Harness candidate that is a tracked subdirectory instead of the repository top level', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-harness-top-level-'))
    const repository = join(fixtureRoot, 'repository')
    const candidate = join(repository, 'upstream', 'deepseek-harness')
    const previousHarnessRoot = process.env.DSH_HARNESS_ROOT
    try {
      await runGit(fixtureRoot, ['init', '--initial-branch=main', 'repository'])
      await runGit(repository, ['config', 'user.email', 'smoke@example.invalid'])
      await runGit(repository, ['config', 'user.name', 'Provider smoke fixture'])
      await mkdir(join(candidate, 'apps', 'cli', 'src'), { recursive: true })
      await writeFile(join(candidate, 'apps', 'cli', 'src', 'bin.ts'), 'nested fake\n')
      await runGit(repository, ['add', 'upstream/deepseek-harness/apps/cli/src/bin.ts'])
      await runGit(repository, ['commit', '-m', 'tracked nested candidate'])
      const expectedCommit = await gitOutput(repository, ['rev-parse', 'HEAD'])
      process.env.DSH_HARNESS_ROOT = candidate
      const discover = findHarnessRoot as unknown as (searchFrom: string, expectedCommit: string) => Promise<string>
      await expect(discover(fixtureRoot, expectedCommit)).rejects.toThrow('pinned deepseek-harness checkout')
    } finally {
      if (previousHarnessRoot === undefined) delete process.env.DSH_HARNESS_ROOT
      else process.env.DSH_HARNESS_ROOT = previousHarnessRoot
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('rejects an untracked fake Harness subdirectory that borrows its parent repository identity', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-untracked-harness-subdir-'))
    const repository = join(fixtureRoot, 'repository')
    const candidate = join(repository, 'untracked', 'deepseek-harness')
    const previousHarnessRoot = process.env.DSH_HARNESS_ROOT
    try {
      const expectedCommit = await initHarnessRepository(repository)
      await mkdir(join(candidate, 'apps', 'cli', 'src'), { recursive: true })
      await writeFile(join(candidate, 'apps', 'cli', 'src', 'bin.ts'), 'untracked fake\n')
      process.env.DSH_HARNESS_ROOT = candidate
      const discover = findHarnessRoot as unknown as (searchFrom: string, expectedCommit: string) => Promise<string>
      await expect(discover(fixtureRoot, expectedCommit)).rejects.toThrow('pinned deepseek-harness checkout')
    } finally {
      if (previousHarnessRoot === undefined) delete process.env.DSH_HARNESS_ROOT
      else process.env.DSH_HARNESS_ROOT = previousHarnessRoot
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('rejects a pinned Harness checkout with tracked worktree changes', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-dirty-harness-'))
    const harness = join(fixtureRoot, 'deepseek-harness')
    const previousHarnessRoot = process.env.DSH_HARNESS_ROOT
    try {
      const expectedCommit = await initHarnessRepository(harness)
      await appendFile(join(harness, 'README.md'), 'dirty tracked state\n')
      process.env.DSH_HARNESS_ROOT = harness
      const discover = findHarnessRoot as unknown as (searchFrom: string, expectedCommit: string) => Promise<string>
      await expect(discover(fixtureRoot, expectedCommit)).rejects.toThrow('pinned deepseek-harness checkout')
    } finally {
      if (previousHarnessRoot === undefined) delete process.env.DSH_HARNESS_ROOT
      else process.env.DSH_HARNESS_ROOT = previousHarnessRoot
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('rejects a CLI entry that is present in the worktree but absent from the pinned HEAD tree', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-untracked-harness-cli-'))
    const harness = join(fixtureRoot, 'deepseek-harness')
    const previousHarnessRoot = process.env.DSH_HARNESS_ROOT
    try {
      const expectedCommit = await initHarnessRepository(harness, false)
      process.env.DSH_HARNESS_ROOT = harness
      const discover = findHarnessRoot as unknown as (searchFrom: string, expectedCommit: string) => Promise<string>
      await expect(discover(fixtureRoot, expectedCommit)).rejects.toThrow('pinned deepseek-harness checkout')
    } finally {
      if (previousHarnessRoot === undefined) delete process.env.DSH_HARNESS_ROOT
      else process.env.DSH_HARNESS_ROOT = previousHarnessRoot
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('rejects a CLI entry whose bytes differ from HEAD even when Git status is hidden', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-hidden-dirty-harness-cli-'))
    const harness = join(fixtureRoot, 'deepseek-harness')
    const previousHarnessRoot = process.env.DSH_HARNESS_ROOT
    try {
      const expectedCommit = await initHarnessRepository(harness)
      await runGit(harness, ['update-index', '--assume-unchanged', 'apps/cli/src/bin.ts'])
      await writeFile(join(harness, 'apps', 'cli', 'src', 'bin.ts'), 'process.stdout.write("forged harness\\n")\n')
      expect(await gitOutput(harness, ['status', '--porcelain', '--untracked-files=no'])).toBe('')
      process.env.DSH_HARNESS_ROOT = harness
      const discover = findHarnessRoot as unknown as (searchFrom: string, expectedCommit: string) => Promise<string>
      await expect(discover(fixtureRoot, expectedCommit)).rejects.toThrow('pinned deepseek-harness checkout')
    } finally {
      if (previousHarnessRoot === undefined) delete process.env.DSH_HARNESS_ROOT
      else process.env.DSH_HARNESS_ROOT = previousHarnessRoot
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })
})
