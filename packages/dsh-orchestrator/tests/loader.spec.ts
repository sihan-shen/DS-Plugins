import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentProvider, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { SINGLE_WORKER_STARTUP_TIMEOUT_MS } from '@ds-plugins/dsh-orchestrator'

const repositoryRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const sourceProfileDir = join(repositoryRoot, 'profiles/v0.1')
const sourceProfileManifest = join(sourceProfileDir, 'package.json')
const sourceProfilePatch = join(sourceProfileDir, 'cordis.patch.yml')
const sourceProfileModules = join(sourceProfileDir, 'node_modules')

interface ProfileLayer {
  readonly patches: readonly Record<string, unknown>[]
}

interface LoadedProfile {
  readonly dir: string
  readonly layers: readonly ProfileLayer[]
  readonly patches: readonly Record<string, unknown>[]
}

interface ProfileEntry {
  readonly id?: string
  readonly name?: string
  readonly config?: unknown
}

interface BootedContext {
  readonly fiber: { dispose(): Promise<void> }
  readonly loader: {
    entries(): Iterable<{ readonly id: string; readonly options: { readonly name: string } }>
    remove(id: string): Promise<void>
  }
  inject(
    dependencies: readonly string[],
    callback: (context: {
      readonly tools: { get(name: string): unknown }
      readonly sessions: { create(id: ReturnType<typeof SessionId>, options: unknown): unknown }
      readonly subagents?: SubagentRuntime
    }) => void,
  ): Promise<unknown>
  get(name: 'tools'): { get(name: string): unknown } | undefined
}

interface AppBoot {
  healProfilesModuleFallback(installAnchor: string, home: string): void
  loadProfile(binName: string, name: string, installAnchor: string, home: string): LoadedProfile
  composeEntries(layers: readonly (readonly Record<string, unknown>[])[]): ProfileEntry[]
  boot(
    binName: string,
    configPath: string,
    patches: readonly Record<string, unknown>[],
  ): Promise<BootedContext>
}

interface ProfileLoadOptions {
  readonly mode: 'direct' | 'single-worker'
  readonly enableSubagents?: boolean
}

interface LoadedProfileRuntime {
  readonly root: string
  readonly resolvedOrchestratorEntry: string
  readonly context: BootedContext
  dispose(): Promise<void>
}

function actualAppBoot(): Promise<AppBoot> {
  return import('@deepseek-ai/dsh-app-boot') as Promise<AppBoot>
}

function profileRequire(profileDir: string) {
  return createRequire(join(profileDir, 'package.json'))
}

function disabledRows(entries: readonly ProfileEntry[], enabled: readonly string[] = []): Record<string, unknown>[] {
  const required = new Set(['session', 'subprocess', 'tools', 'system-prompt', 'ds-orchestrator'])
  for (const id of enabled) required.add(id)
  return entries.flatMap(entry => entry.id === undefined || required.has(entry.id)
    ? []
    : [{ id: entry.id, disabled: true }])
}

function singleWorkerOverlay(entries: readonly ProfileEntry[]): Record<string, unknown> {
  const orchestrator = entries.find(entry => entry.id === 'ds-orchestrator')
  if (orchestrator?.config === undefined || typeof orchestrator.config !== 'object' || Array.isArray(orchestrator.config)) {
    throw new Error('actual profile did not compose the ds-orchestrator configuration')
  }
  const config = structuredClone(orchestrator.config) as Record<string, unknown>
  const budgets = config.budgets
  if (budgets === undefined || typeof budgets !== 'object' || Array.isArray(budgets)) {
    throw new Error('actual profile ds-orchestrator configuration has no budgets')
  }
  return {
    id: 'ds-orchestrator',
    config: {
      ...config,
      mode: 'single-worker',
      budgets: { ...(budgets as Record<string, unknown>), maxWorkers: 1 },
    },
  }
}

async function copyActualProfile(root: string): Promise<string> {
  const profileDir = join(root, 'profiles/v0.1')
  await mkdir(profileDir, { recursive: true })
  await Promise.all([
    copyFile(sourceProfileManifest, join(profileDir, 'package.json')),
    copyFile(sourceProfilePatch, join(profileDir, 'cordis.patch.yml')),
  ])
  await symlink(sourceProfileModules, join(profileDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n')
  return profileDir
}

async function loadActualProfile(options: ProfileLoadOptions): Promise<LoadedProfileRuntime> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-orchestrator-profile-'))
  try {
    const profileDir = await copyActualProfile(root)
    const appBoot = await actualAppBoot()
    const resolver = profileRequire(profileDir)
    const dshBaseManifest = resolver.resolve('@deepseek-ai/dsh-base/package.json')
    appBoot.healProfilesModuleFallback(dshBaseManifest, root)
    const profile = appBoot.loadProfile('dsh-orchestrator-loader-test', 'v0.1', dshBaseManifest, root)
    const profilePatches = [
      ...profile.layers.flatMap(layer => layer.patches),
      ...profile.patches,
    ]
    const entries = appBoot.composeEntries([profilePatches])
    const patches = [
      ...profilePatches,
      ...disabledRows(entries, options.enableSubagents ? ['subagent'] : []),
      ...(options.mode === 'single-worker' ? [singleWorkerOverlay(entries)] : []),
    ]
    const resolvedOrchestratorEntry = resolver.resolve('@ds-plugins/dsh-orchestrator')
    const context = await appBoot.boot(
      'dsh-orchestrator-loader-test',
      join(profile.dir, 'cordis.yml'),
      patches,
    )
    return {
      root,
      resolvedOrchestratorEntry,
      context,
      async dispose() {
        try {
          await context.fiber.dispose()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function injectedServices(context: BootedContext, requireSubagents = false): Promise<{
  readonly tools: { get(name: string): unknown }
  readonly sessions: { create(id: ReturnType<typeof SessionId>, options: unknown): unknown }
  readonly subagents?: SubagentRuntime
}> {
  let services: {
    readonly tools: { get(name: string): unknown }
    readonly sessions: { create(id: ReturnType<typeof SessionId>, options: unknown): unknown }
    readonly subagents?: SubagentRuntime
  } | undefined
  await context.inject(requireSubagents ? ['tools', 'sessions', 'subagents'] : ['tools', 'sessions'], child => {
    services = child
  })
  if (services === undefined) throw new Error('actual profile did not inject its required services')
  return services
}

function fakeSpawnProvider(): SubagentProvider {
  return {
    name: 'spawn',
    inheritsParentContext: false,
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    async start(request) {
      return {
        id: SessionId(`keyless-child:${request.parent.id}`),
        localAgent: undefined,
        result: Promise.resolve({
          stopReason: 'completed',
          output: [],
          structured: {
            schemaVersion: 1,
            status: 'completed',
            summary: 'Keyless worker completed.',
            changedFiles: [],
            decisions: [],
            verification: [],
            blockers: [],
          },
        }),
        async dispose() {},
      }
    },
  }
}

async function withActualProfile<T>(options: ProfileLoadOptions, callback: (runtime: LoadedProfileRuntime) => Promise<T>): Promise<T> {
  const runtime = await loadActualProfile(options)
  try {
    return await callback(runtime)
  } finally {
    await runtime.dispose()
  }
}

describe('built DSH v0.1 profile Loader composition', () => {
  it('requires the test command to build the profile-resolved package entry', () => {
    const entry = profileRequire(sourceProfileDir).resolve('@ds-plugins/dsh-orchestrator')
    expect(entry).toMatch(/[\\/]packages[\\/]dsh-orchestrator[\\/]lib[\\/]index\.mjs$/)
  })

  it('boots the actual Direct profile through the bare built package entry and disposes it through the root Include', async () => {
    let root = ''
    await withActualProfile({ mode: 'direct' }, async (runtime) => {
      root = runtime.root
      expect(runtime.resolvedOrchestratorEntry).toMatch(/[\\/]packages[\\/]dsh-orchestrator[\\/]lib[\\/]index\.mjs$/)
      expect(runtime.resolvedOrchestratorEntry).not.toMatch(/[\\/]src[\\/]/)
      const entry = [...runtime.context.loader.entries()].find(candidate => candidate.id === 'include:ds-orchestrator')
      expect(entry?.options.name).toBe('@ds-plugins/dsh-orchestrator')
      const services = await injectedServices(runtime.context)
      expect(services.tools.get('targeted_verify')).toBeDefined()
      expect(services.tools.get('delegate_worker')).toBeUndefined()

      await runtime.context.loader.remove('include')
      expect(runtime.context.get('tools')?.get('targeted_verify')).toBeUndefined()
    })
    expect(existsSync(root)).toBe(false)
  })

  it('fails Single Worker profile boot observably when the required subagents service is unavailable', async () => {
    await expect(loadActualProfile({ mode: 'single-worker' })).rejects.toThrow(/single-worker.*subagents.*timeout/i)
  }, SINGLE_WORKER_STARTUP_TIMEOUT_MS + 2_000)

  it('uses the actual Loader-provided subagents service for one keyless Single Worker child', async () => {
    await withActualProfile({ mode: 'single-worker', enableSubagents: true }, async (runtime) => {
      const services = await injectedServices(runtime.context, true)
      const service = services.subagents
      if (service === undefined) throw new Error('actual profile did not inject the official subagents service')
      const unregister = service.registerProvider(fakeSpawnProvider())
      try {
        const delegate = services.tools.get('delegate_worker') as {
          execute(
            input: unknown,
            exec: { readonly signal: AbortSignal; readonly agent: unknown; deferContext(value: unknown): void },
          ): Promise<unknown>
        } | undefined
        expect(delegate).toBeDefined()

        const session = services.sessions.create(SessionId('loader-single-worker-root'), { meta: { cwd: repositoryRoot } }) as {
          readonly id: ReturnType<typeof SessionId>
          readonly header: { readonly parentSession?: unknown }
        }
        const contexts: unknown[] = []
        await expect(delegate?.execute(
          { task: 'Return the bounded keyless handoff.', allowedTools: ['read_file'] },
          {
            signal: new AbortController().signal,
            agent: { id: session.id, session },
            deferContext(value) { contexts.push(value) },
          },
        )).resolves.toMatchObject({ status: 'completed', summary: 'Keyless worker completed.' })
        expect(contexts).toHaveLength(1)
      } finally {
        unregister()
      }
    })
  })
})
