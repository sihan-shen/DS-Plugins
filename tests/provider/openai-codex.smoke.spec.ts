import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { findHarnessRoot } from './openai-codex.smoke.ts'

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

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<FakeSmokeResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolveRun({ code, stdout, stderr }))
  })
}

async function runAuthorizedFakeSmoke(scenario: FakeSmokeScenario): Promise<FakeSmokeResult> {
  const harnessWorkspace = await findHarnessRoot()
  const fakeHarness = await mkdtemp(join(harnessWorkspace, '.fake-harness-'))
  const fakeHome = await mkdtemp(join(tmpdir(), 'dsh-provider-smoke-home-'))
  const capturePath = join(fakeHarness, 'capture.jsonl')
  try {
    const cli = join(fakeHarness, 'apps/cli/src/bin.ts')
    await mkdir(dirname(cli), { recursive: true })
    await writeFile(cli, fakeCli)
    const result = await run(process.execPath, ['--experimental-strip-types', scriptPath], {
      ...process.env,
      DSH_RUN_OPENAI_CODEX_SMOKE: '1',
      DSH_HARNESS_ROOT: fakeHarness,
      DSH_HOME: fakeHome,
      DSH_FAKE_SMOKE_SCENARIO: scenario,
      DSH_FAKE_CAPTURE_PATH: capturePath,
      TMPDIR: harnessWorkspace,
    })
    const trace = await readFile(capturePath, 'utf8').catch(() => '')
    return { ...result, trace }
  } finally {
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
    expect(result.code).toBe(0)
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
      await runGit(repository, ['worktree', 'add', '--detach', decoy, 'HEAD'])
      await mkdir(join(harness, 'apps', 'cli', 'src'), { recursive: true })
      await writeFile(join(harness, 'apps', 'cli', 'src', 'bin.ts'), '')
      await mkdir(join(decoy, 'apps', 'cli', 'src'), { recursive: true })
      await writeFile(join(decoy, 'apps', 'cli', 'src', 'bin.ts'), '')
      delete process.env.DSH_HARNESS_ROOT
      const expectedCommit = await gitOutput(repository, ['rev-parse', 'HEAD'])
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
})
